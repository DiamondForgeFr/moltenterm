// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import { BrokkHub } from "./brokk-hub";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import { DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;

function item(key: string, tone: ToHandleItem["tone"], since: number): ToHandleItem {
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

function agent(blockid: string, state: AgentStateInfo["state"]): AgentStateInfo {
    return { blockid, agent: "claude", firstname: blockid, state, version: 1, since: 1 };
}

function states(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((info) => [info.blockid, info])), versions: {} };
}

// The window's sources, as primitive atoms in a store of their own; the hub runs on a clock the test sets.
function window_(over: { loaded?: boolean; onScreen?: boolean; card?: boolean } = {}) {
    const store = createStore();
    const sources = {
        agents: atom(states()) as PrimitiveAtom<AgentStatesData>,
        loaded: atom(over.loaded ?? true) as PrimitiveAtom<boolean>,
        rows: atom({ items: [], info: [], parked: 0 } as ToHandleList) as PrimitiveAtom<ToHandleList>,
        settings: atom(DefaultVisitSettings) as PrimitiveAtom<VisitSettings>,
        onScreen: atom(over.onScreen ?? true) as PrimitiveAtom<boolean>,
        search: atom(false) as PrimitiveAtom<boolean>,
        drag: atom(false) as PrimitiveAtom<boolean>,
        card: atom(over.card ?? false) as PrimitiveAtom<boolean>,
    };
    const clock = { now: T };
    const state = { panels: 0 };
    const hub = new BrokkHub({
        now: () => clock.now,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => store.get(sources.card),
        openPanel: () => {
            state.panels++;
            store.set(sources.card, true);
        },
        readShared: () => EmptyShared,
        writeShared: () => {},
    });
    const stop = feedBrokkHub(hub, {
        store,
        agentsAtom: sources.agents,
        agentsLoadedAtom: sources.loaded,
        toHandleAtom: sources.rows,
        settingsAtom: sources.settings,
        sidebarOnScreenAtom: sources.onScreen,
        searchOpenAtom: sources.search,
        dragAtom: sources.drag,
        cardOpenAtom: sources.card,
    });
    const list = (...items: ToHandleItem[]) => store.set(sources.rows, { items, info: [], parked: 0 });
    return { store, sources, clock, state, hub, stop, list };
}

describe("what feeds Brokk's hub (FR-BOSS-009, AC11)", () => {
    it("raises a visit from the rows To handle, and cancels it when the row is gone", () => {
        const w = window_();
        w.list(item("agent:a", "waiting", T - 6 * Min));
        expect(w.hub.getView().visit?.severity).toBe("important");
        w.list();
        expect(w.hub.getView().visit).toBeNull();
    });

    it("reads nothing before the first readings are in", () => {
        const w = window_({ loaded: false });
        w.list(item("agent:a", "waiting", T - 6 * Min));
        expect(w.hub.getView().visit).toBeNull();
        w.store.set(w.sources.loaded, true);
        expect(w.hub.getView().visit).not.toBeNull();
    });

    it("counts an agent that finished after the first reading, not before", () => {
        const w = window_();
        w.store.set(w.sources.agents, states(agent("a", "done")));
        expect(w.hub.getView().badge).toBe(0);
        w.store.set(w.sources.agents, states(agent("a", "working"), agent("b", "working")));
        w.store.set(w.sources.agents, states(agent("a", "done"), agent("b", "working")));
        expect(w.hub.getView().badge).toBe(1);
    });

    it("follows the settings", () => {
        const w = window_();
        w.list(item("agent:b", "error", T - 1 * Min));
        expect(w.hub.getView().visit).toBeNull();
        w.store.set(w.sources.settings, {
            ...DefaultVisitSettings,
            coming: { ...DefaultVisitSettings.coming, error: "vient" },
        });
        expect(w.hub.getView().visit?.expression).toBe("doubtful");
        w.store.set(w.sources.settings, { ...DefaultVisitSettings, never: true });
        expect(w.hub.getView().visit).toBeNull();
    });

    it("holds the visit while the sidebar is off screen, the search field is open or a drag is under way", () => {
        const w = window_({ onScreen: false });
        w.list(item("agent:a", "waiting", T - 6 * Min));
        expect(w.hub.getView().visit).toBeNull();
        expect(w.hub.getView().cue).toBe(true);
        w.store.set(w.sources.onScreen, true);
        expect(w.hub.getView().visit).not.toBeNull();

        const search = window_();
        search.store.set(search.sources.search, true);
        search.list(item("agent:a", "waiting", T - 6 * Min));
        expect(search.hub.getView().visit).toBeNull();

        const drag = window_();
        drag.store.set(drag.sources.drag, true);
        drag.list(item("agent:a", "waiting", T - 6 * Min));
        expect(drag.hub.getView().visit).toBeNull();
    });

    it("does not count its own start as a drag that ended", () => {
        const w = window_();
        w.list(item("agent:a", "waiting", T - 6 * Min));
        expect(w.hub.getView().visit).not.toBeNull();
    });

    it("tells what waited when his panel opens, however it was opened", () => {
        const w = window_();
        w.list(item("agent:a", "waiting", T - 6 * Min));
        w.store.set(w.sources.card, true);
        expect(w.hub.getView().visit).toBeNull();
        expect(w.state.panels).toBe(0);
    });

    it("stops listening", () => {
        const w = window_();
        w.stop();
        w.list(item("agent:a", "waiting", T - 6 * Min));
        expect(w.hub.getView().visit).toBeNull();
    });
});
