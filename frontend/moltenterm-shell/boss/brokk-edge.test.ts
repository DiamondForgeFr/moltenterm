// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import type { ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import { AfterActionMs } from "./brokk-gate";
import { BrokkHub, HubDeps } from "./brokk-hub";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import { edgeShapeOf } from "./brokk-edge-model";
import { DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

import { globalStore } from "@/app/store/jotaiStore";
import { BrokkEdgeModel } from "./brokk-edge-store";

// 14:00 on the local clock, so that the default quiet hours (22:00 to 08:00) are far away.
const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;

function row(key: string, tone: ToHandleItem["tone"], since: number): ToHandleItem {
    return {
        key,
        tone,
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: key },
        place: "",
        since,
        rank: 1,
        seen: false,
        actions: [],
    };
}

// An agent that has waited for the developer for 6 minutes: past the 5 min threshold, so he comes.
const BlockedRow = () => row("agent:a", "waiting", T - 6 * Min);

function fixture(start: number = T) {
    const clock = { now: start };
    const state = { overlay: false, panels: 0 };
    const deps: HubDeps = {
        now: () => clock.now,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => state.overlay,
        openPanel: () => {
            state.panels++;
        },
        readShared: () => EmptyShared,
        writeShared: () => {},
    };
    return { hub: new BrokkHub(deps), clock, state };
}

// What the window's feed tells the hub when the sidebar is collapsed with his face on it: it is not on screen, and it
// is at the edge.
function collapse(hub: BrokkHub, edge = true) {
    hub.gate({ type: "hidden", hidden: true });
    hub.gate({ type: "edge", edge });
}

const shapeOf = (hub: BrokkHub) =>
    edgeShapeOf("edge", { visit: hub.getView().visit != null, cue: hub.getView().cue });

describe("a visit in a collapsed sidebar (FR-BOSS-009, AC29, #2070)", () => {
    it("keeps the sidebar half open as soon as something important waits", () => {
        const { hub } = fixture();
        collapse(hub);
        expect(shapeOf(hub)).toBe("rest");
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit?.severity).toBe("important");
        expect(shapeOf(hub)).toBe("ajar");
    });

    it("waits for the sidebar to show when the edge is not there: the same event leaves it at rest", () => {
        const { hub } = fixture();
        collapse(hub, false);
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().cue).toBe(true);
    });

    it("is not held by the pointer, the search field, a drag or a click: nothing of the sidebar is under the pointer", () => {
        const { hub } = fixture();
        collapse(hub);
        hub.gate({ type: "enter" });
        hub.gate({ type: "act" });
        hub.gate({ type: "search", focused: true });
        hub.gate({ type: "dragstart" });
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).not.toBeNull();
        expect(AfterActionMs).toBeGreaterThan(0);
    });

    it("stays held by quiet hours, which keep it at rest without a cue", () => {
        const night = new Date(2026, 10, 6, 22, 30, 0).getTime();
        const { hub } = fixture(night);
        collapse(hub);
        hub.syncRows([row("agent:a", "waiting", night - 6 * Min)]);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().cue).toBe(false);
        expect(shapeOf(hub)).toBe("rest");
    });

    it("stays held by an event set to Badge, and by the master switch", () => {
        const badge = fixture();
        collapse(badge.hub);
        badge.hub.settings({ ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, blocked: "badge" } });
        badge.hub.syncRows([BlockedRow()]);
        expect(shapeOf(badge.hub)).toBe("rest");
        expect(badge.hub.getView().badge).toBe(1);

        const never = fixture();
        collapse(never.hub);
        never.hub.settings({ ...DefaultVisitSettings, never: true } as VisitSettings);
        never.hub.syncRows([BlockedRow()]);
        expect(shapeOf(never.hub)).toBe("rest");
    });

    it("stays held while a menu, a dialog or his group is open, and is half open for it meanwhile", () => {
        const { hub, state } = fixture();
        collapse(hub);
        state.overlay = true;
        hub.syncRows([BlockedRow()]);
        expect(hub.getView().visit).toBeNull();
        expect(shapeOf(hub)).toBe("ajar");
    });

    it("closes again once the item is handled", () => {
        const { hub } = fixture();
        collapse(hub);
        hub.syncRows([BlockedRow()]);
        expect(shapeOf(hub)).toBe("ajar");
        hub.syncRows([]);
        expect(hub.getView().visit).toBeNull();
        expect(shapeOf(hub)).toBe("rest");
    });

    it("closes again once it is told: his group opened on it", () => {
        const { hub, state } = fixture();
        collapse(hub);
        hub.syncRows([BlockedRow()]);
        hub.open();
        expect(state.panels).toBe(1);
        expect(shapeOf(hub)).toBe("rest");
    });

    it("closes again once it is put off with Plus tard, and does not come back until the delay ends", () => {
        const { hub, clock } = fixture();
        collapse(hub);
        hub.syncRows([BlockedRow()]);
        hub.later("escape");
        expect(shapeOf(hub)).toBe("rest");
        clock.now += 5 * Min;
        hub.syncRows([BlockedRow(), row("agent:b", "error", clock.now - Min)]);
        expect(shapeOf(hub)).toBe("rest");
        clock.now += 11 * Min;
        hub.wake();
        expect(shapeOf(hub)).toBe("ajar");
    });

    it("is already there when the sidebar is unfolded over the pointer: the hover shows his banner, nothing arrives under it", () => {
        const { hub } = fixture();
        collapse(hub);
        hub.syncRows([BlockedRow()]);
        const visit = hub.getView().visit;
        hub.gate({ type: "hidden", hidden: false });
        hub.gate({ type: "edge", edge: false });
        hub.gate({ type: "enter" });
        expect(hub.getView().visit).toBe(visit);
    });
});

describe("the visit keeps working as it does, open or collapsed (FR-BOSS-009, AC5 to AC7, #2005, #2006, #2070)", () => {
    const events = () => [BlockedRow(), row("agent:b", "error", T - Min)];

    it("is the same visit in a collapsed sidebar and in an open one: the same severity, face and events", () => {
        const open = fixture();
        open.hub.syncRows(events());
        const collapsed = fixture();
        collapse(collapsed.hub);
        collapsed.hub.syncRows(events());
        expect(collapsed.hub.getView().visit).not.toBeNull();
        expect(collapsed.hub.getView().visit).toEqual(open.hub.getView().visit);
    });

    it("still arrives in a collapsed sidebar, once at the moment it is collapsed too", () => {
        const { hub } = fixture();
        hub.syncRows(events());
        hub.gate({ type: "hidden", hidden: true });
        hub.gate({ type: "edge", edge: true });
        expect(hub.getView().visit?.severity).toBe("important");
        expect(hub.getView().visit?.expression).toBe("doubtful");
    });

    it("keeps its actions in a collapsed sidebar: a click opens his group, and Plus tard asks when to come back", () => {
        const clicked = fixture();
        collapse(clicked.hub);
        clicked.hub.syncRows(events());
        clicked.hub.open();
        expect(clicked.state.panels).toBe(1);
        expect(clicked.hub.getView().visit).toBeNull();

        const later = fixture();
        collapse(later.hub);
        later.hub.syncRows(events());
        later.hub.later("15min");
        expect(later.hub.getView().visit).toBeNull();
        expect(later.hub.getView().laterUntil).toBe(T + 15 * Min);
    });

    it("is the visit of the sidebar as a banner when it unfolds, and again as before once docked", () => {
        const { hub } = fixture();
        collapse(hub);
        hub.syncRows(events());
        const visit = hub.getView().visit;
        hub.gate({ type: "hidden", hidden: false });
        hub.gate({ type: "edge", edge: false });
        expect(hub.getView().visit).toBe(visit);
        hub.later("escape");
        hub.syncRows(events());
        expect(hub.getView().visit).toBeNull();
    });
});

describe("the example visit of the settings shows in a collapsed sidebar too (FR-BOSS-009, AC31 to AC33, #2079, #2070)", () => {
    it("keeps the sidebar half open on the example, which counts for nothing", () => {
        const { hub } = fixture();
        collapse(hub);
        hub.showExample();
        expect(hub.getView().visit?.example).toBe(true);
        expect(shapeOf(hub)).toBe("ajar");
        expect(hub.getView().badge).toBe(0);
        expect(hub.getView().badgeKeys).toEqual([]);
    });

    it("comes through quiet hours and the master switch, as it does in an open sidebar", () => {
        const night = new Date(2026, 10, 6, 22, 30, 0).getTime();
        const { hub } = fixture(night);
        collapse(hub);
        hub.settings({ ...DefaultVisitSettings, never: true } as VisitSettings);
        hub.showExample();
        expect(shapeOf(hub)).toBe("ajar");
    });

    it("is the banner of the sidebar that unfolds, and closes back to the strip when its action closes it", () => {
        const { hub, state } = fixture();
        collapse(hub);
        hub.showExample();
        const example = hub.getView().visit;
        hub.gate({ type: "hidden", hidden: false });
        hub.gate({ type: "edge", edge: false });
        hub.gate({ type: "enter" });
        expect(hub.getView().visit).toBe(example);
        collapse(hub);
        hub.closeExample();
        expect(hub.getView().visit).toBeNull();
        expect(shapeOf(hub)).toBe("rest");
        expect(state.panels).toBe(0);
    });

    it("gives the visit the model holds back once it is closed, half open for it", () => {
        const { hub } = fixture();
        collapse(hub);
        hub.syncRows([BlockedRow()]);
        hub.showExample();
        expect(hub.getView().visit?.example).toBe(true);
        hub.closeExample();
        expect(hub.getView().visit?.severity).toBe("important");
        expect(shapeOf(hub)).toBe("ajar");
    });

    it("is not news for the bounce: nothing is raised, so nothing is told by moving", () => {
        const { hub } = fixture();
        hub.markReady();
        collapse(hub);
        const keys = hub.getView().badgeKeys;
        hub.showExample();
        expect(hub.getView().badgeKeys).toEqual(keys);
    });
});

function window_(over: { loaded?: boolean; edge?: boolean } = {}) {
    const store = createStore();
    const sources = {
        agents: atom({ states: {}, versions: {} } as AgentStatesData) as PrimitiveAtom<AgentStatesData>,
        loaded: atom(over.loaded ?? true) as PrimitiveAtom<boolean>,
        rows: atom({ items: [], info: [], parked: 0 } as ToHandleList) as PrimitiveAtom<ToHandleList>,
        settings: atom(DefaultVisitSettings) as PrimitiveAtom<VisitSettings>,
        onScreen: atom(false) as PrimitiveAtom<boolean>,
        edge: atom(over.edge ?? true) as PrimitiveAtom<boolean>,
        card: atom(false) as PrimitiveAtom<boolean>,
    };
    const { hub } = fixture();
    const stop = feedBrokkHub(hub, {
        store,
        agentsAtom: sources.agents,
        agentsLoadedAtom: sources.loaded,
        toHandleAtom: sources.rows,
        settingsAtom: sources.settings,
        sidebarOnScreenAtom: sources.onScreen,
        sidebarEdgeAtom: sources.edge,
        searchOpenAtom: atom(false),
        dragAtom: atom(false),
        cardOpenAtom: sources.card,
    });
    return { store, sources, hub, stop };
}

describe("what the window feeds the hub with when the sidebar is collapsed (#2070)", () => {
    it("tells it the sidebar is at the edge, and when it is not any more", () => {
        const { store, sources, hub, stop } = window_();
        store.set(sources.rows, { items: [BlockedRow()], info: [], parked: 0 });
        expect(hub.getView().visit).not.toBeNull();
        store.set(sources.edge, false);
        store.set(sources.rows, { items: [BlockedRow(), row("agent:b", "error", T)], info: [], parked: 0 });
        expect(hub.getModel().gate.edge).toBe(false);
        stop();
    });

    it("is ready once the feeds have been read, not before: what was there is no news", () => {
        const loading = window_({ loaded: false });
        expect(loading.hub.getView().ready).toBe(false);
        loading.store.set(loading.sources.loaded, true);
        expect(loading.hub.getView().ready).toBe(true);
        loading.stop();
        const loaded = window_();
        expect(loaded.hub.getView().ready).toBe(true);
        loaded.stop();
    });

    it("names the keys the badge counts, to tell a new notification from one told", () => {
        const { store, sources, hub, stop } = window_();
        store.set(sources.rows, { items: [BlockedRow()], info: [], parked: 0 });
        expect(hub.getView().badgeKeys).toHaveLength(1);
        expect(hub.getView().badge).toBe(1);
        stop();
    });
});

describe("what the collapsed sidebar has told by moving (AC28)", () => {
    const model = BrokkEdgeModel.getInstance();
    const bounces = () => globalStore.get(model.bounceAtom);
    const unseen = () => globalStore.get(model.unseenAtom);

    beforeEach(() => model.reset());

    it("counts one bounce per new notification, and none for the first reading or for one already told", () => {
        model.tell([], false, false);
        model.tell(["agent:a"], false, true);
        expect(bounces()).toBe(0);
        model.tell(["agent:a", "agent:b"], false, true);
        expect(bounces()).toBe(1);
        model.tell(["agent:a", "agent:b"], false, true);
        expect(bounces()).toBe(1);
        model.tell(["agent:a", "agent:b", "download:c"], false, true);
        expect(bounces()).toBe(2);
    });

    it("counts none for a notification that arrives while the developer looks, and leaves nothing unseen", () => {
        model.tell([], false, true);
        model.tell([], false, true);
        model.tell(["agent:a"], true, true);
        expect(bounces()).toBe(0);
        expect(unseen()).toBe(false);
        model.tell(["agent:a"], false, true);
        expect(bounces()).toBe(0);
    });

    it("keeps a notification unseen, for the face's outline, until the developer looks", () => {
        model.tell([], false, true);
        model.tell([], false, true);
        model.tell(["agent:a"], false, true);
        expect(unseen()).toBe(true);
        model.tell(["agent:a"], true, true);
        expect(unseen()).toBe(false);
    });
});
