// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view pinned everywhere stays a base (FR-SHELL-080, #1272): changing its panels makes it a temporary view of the
// workspace, and Update the pinned view applies the change to every workspace.

import { describe, expect, it } from "vitest";
import { viewMenuPlan } from "./view-menu-model";
import {
    applyMetaPatch,
    ForkCheck,
    forkDue,
    ForkedFromMetaKey,
    forkOrigin,
    GlobalPin,
    GlobalPinMetaKey,
    GlobalPinRevMetaKey,
    instanceStale,
    layoutSettled,
    PinConfig,
    PinConfigMetaKey,
    PinMetaKey,
    pinMetaOf,
    PinNode,
    PinWorkspace,
    planPinUpdate,
    planViewFork,
    undoPinUpdate,
    viewForked,
    ViewIconMetaKey,
    viewModified,
    viewStateOf,
} from "./view-pins-model";

const base: PinConfig = {
    tree: { dir: "row", children: [{ pane: 0 }, { pane: 1 }] },
    panes: [
        { view: "term", controller: "shell" },
        { view: "molten-browser", url: "https://github.com/pulls" },
    ],
};
const pin: GlobalPin = { id: "g1", name: "Review", icon: "gear", rev: 3, config: base };
const other: GlobalPin = { id: "g0", name: "Docs", rev: 1, config: base };

const blocks: Record<string, Record<string, any>> = {
    term: { view: "term", controller: "shell", "cmd:cwd": "/a" },
    web: { view: "molten-browser", url: "https://github.com/pulls" },
    term2: { view: "term", controller: "shell" },
};
const metaOf = (id: string) => blocks[id] ?? null;
const asPinned: PinNode = { dir: "row", children: [{ blockid: "term" }, { blockid: "web" }] };
const split: PinNode = {
    dir: "row",
    children: [{ dir: "column", children: [{ blockid: "term" }, { blockid: "term2" }] }, { blockid: "web" }],
};

const instanceMeta = { "tab:name": "Review", bg: "#123", [GlobalPinMetaKey]: "g1", [GlobalPinRevMetaKey]: 3 };

function check(over: Partial<ForkCheck>): ForkCheck {
    return {
        state: "everywhere",
        changed: true,
        projectTab: false,
        onScreen: true,
        dragging: false,
        stale: false,
        ...over,
    };
}

describe("a view pinned everywhere forks on a panel change (#1272)", () => {
    it("sees a split, a closed or an added panel as a change of the layout", () => {
        expect(viewForked(base, asPinned, metaOf)).toBe(false);
        expect(viewForked(base, split, metaOf)).toBe(true);
        expect(viewForked(base, { blockid: "term" }, metaOf)).toBe(true);
        expect(viewForked(base, { dir: "column", children: [{ blockid: "term" }, { blockid: "web" }] }, metaOf)).toBe(
            true
        );
    });

    it("never forks on content: a page on another site, a terminal's folder, an agent in its slot", () => {
        const browsed = (id: string) =>
            id === "web" ? { view: "molten-browser", url: "https://example.com/docs" } : metaOf(id);
        expect(viewForked(base, asPinned, browsed)).toBe(false);
        const cd = (id: string) =>
            id === "term" ? { view: "term", "cmd:cwd": "/elsewhere", "molten:agentslot": null } : metaOf(id);
        expect(viewForked(base, asPinned, cd)).toBe(false);
        // A tile still sees the site change as "modified" (today's amber pip).
        expect(viewModified(base, asPinned, browsed)).toBe(true);
    });

    it("forks only an instance pinned everywhere, on screen, outside a drag or a rebuild", () => {
        expect(forkDue(check({}))).toBe(true);
        expect(forkDue(check({ changed: false }))).toBe(false);
        expect(forkDue(check({ state: "workspace" }))).toBe(false);
        expect(forkDue(check({ state: "temporary" }))).toBe(false);
        expect(forkDue(check({ projectTab: true }))).toBe(false);
        expect(forkDue(check({ onScreen: false }))).toBe(false);
        expect(forkDue(check({ dragging: true }))).toBe(false);
        expect(forkDue(check({ stale: true }))).toBe(false);
        expect(layoutSettled({ pendingbackendactions: [{}] })).toBe(false);
        expect(layoutSettled({ pendingbackendactions: [] })).toBe(true);
        expect(layoutSettled(null)).toBe(true);
    });

    it("turns the instance into a temporary view of the same tab, the pin untouched", () => {
        const pins = [other, pin];
        const patch = planViewFork(pin);
        const after = applyMetaPatch(instanceMeta, patch);
        const ids = new Set(pins.map((p) => p.id));
        expect(viewStateOf({ meta: after }, ids)).toBe("temporary");
        expect(after).toMatchObject({ "tab:name": "Review", bg: "#123", [ViewIconMetaKey]: "gear" });
        expect(after[ForkedFromMetaKey]).toBe("g1");
        expect(forkOrigin({ meta: after }, pins)).toEqual(pin);
        expect(pins).toEqual([other, pin]);
        expect(pin.config).toBe(base);
    });

    it("tiles keep the amber pip: a changed tile never forks", () => {
        const tile = { [PinMetaKey]: PinWorkspace, [PinConfigMetaKey]: base };
        expect(viewStateOf({ meta: tile }, new Set(["g1"]))).toBe("workspace");
        expect(forkDue(check({ state: viewStateOf({ meta: tile }, new Set(["g1"])) }))).toBe(false);
        expect(viewMenuPlan("workspace", true).saveOrRevert).toBe(true);
    });
});

describe("Update the pinned view (#1272)", () => {
    const forked = applyMetaPatch(instanceMeta, planViewFork(pin));
    const captured: PinConfig = { tree: split as any, panes: [{ view: "term" }, { view: "term" }, { view: "web" }] };

    it("writes the layout to the pin and makes the tab its instance again", () => {
        const update = planPinUpdate([other, pin], "g1", captured);
        expect(update.pin).toMatchObject({ id: "g1", name: "Review", icon: "gear", rev: 4, config: captured });
        expect(update.pins.map((p) => p.id)).toEqual(["g0", "g1"]);
        const after = applyMetaPatch(forked, update.tabMeta);
        expect(viewStateOf({ meta: after }, new Set(["g0", "g1"]))).toBe("everywhere");
        expect(after[GlobalPinRevMetaKey]).toBe(4);
        expect(after[ForkedFromMetaKey]).toBeUndefined();
        expect(instanceStale({ meta: after }, update.pin)).toBe(false);
        expect(after).toMatchObject({ "tab:name": "Review", bg: "#123" });
    });

    it("the other workspaces' instances follow: they are older than the pin", () => {
        const update = planPinUpdate([other, pin], "g1", captured);
        expect(instanceStale({ meta: instanceMeta }, update.pin)).toBe(true);
    });

    it("another instance opened here meanwhile becomes a temporary view, nothing closed", () => {
        const update = planPinUpdate([other, pin], "g1", captured);
        const second = applyMetaPatch(instanceMeta, update.othersMeta);
        expect(viewStateOf({ meta: second }, new Set(["g1"]))).toBe("temporary");
        expect(second[ForkedFromMetaKey]).toBeUndefined();
    });

    it("Undo writes the previous configuration as a newer revision, and the view is temporary again", () => {
        const update = planPinUpdate([other, pin], "g1", captured);
        const back = undoPinUpdate(update.pins, pin);
        const restored = back.find((p) => p.id === "g1");
        expect(restored.config).toBe(base);
        expect(restored.rev).toBe(5);
        // Every instance made from the update is older again, so it follows back.
        expect(instanceStale({ meta: { [GlobalPinRevMetaKey]: 4 } }, restored)).toBe(true);
        const tabBack = applyMetaPatch(applyMetaPatch(forked, update.tabMeta), pinMetaOf(forked));
        expect(tabBack).toEqual(forked);
    });

    it("is offered while the view comes from a pin that still exists", () => {
        expect(viewMenuPlan("temporary", false, false, true).updatePinned).toBe(true);
        expect(viewMenuPlan("temporary", false, false, false).updatePinned).toBe(false);
        expect(viewMenuPlan("everywhere", true, false, true).updatePinned).toBe(false);
        expect(forkOrigin({ meta: forked }, [other])).toBeNull();
        expect(planPinUpdate([other], "g1", captured)).toBeNull();
    });
});
