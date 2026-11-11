// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import { BrokkHub } from "./brokk-hub";
import { avatarBadgeOf } from "./brokk-hub-feed";
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
function window_(
    over: { loaded?: boolean; onScreen?: boolean; card?: boolean; on?: boolean; rows?: ToHandleItem[] } = {}
) {
    const store = createStore();
    const sources = {
        agents: atom(states()) as PrimitiveAtom<AgentStatesData>,
        loaded: atom(over.loaded ?? true) as PrimitiveAtom<boolean>,
        rows: atom({ items: over.rows ?? [], info: [], parked: 0 } as ToHandleList) as PrimitiveAtom<ToHandleList>,
        settings: atom(DefaultVisitSettings) as PrimitiveAtom<VisitSettings>,
        on: atom(over.on ?? true) as PrimitiveAtom<boolean>,
        onScreen: atom(over.onScreen ?? true) as PrimitiveAtom<boolean>,
        search: atom(false) as PrimitiveAtom<boolean>,
        drag: atom(false) as PrimitiveAtom<boolean>,
        card: atom(over.card ?? false) as PrimitiveAtom<boolean>,
        openDone: atom(null) as PrimitiveAtom<ReadonlySet<string>>,
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
        onAtom: sources.on,
        sidebarOnScreenAtom: sources.onScreen,
        searchOpenAtom: sources.search,
        dragAtom: sources.drag,
        cardOpenAtom: sources.card,
        openDoneAtom: sources.openDone,
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

    describe("the developer's own archive raises nothing (#2210)", () => {
        // The face's badge, as the avatar draws it (use-brokk-hub.ts useAvatarBadge).
        function faceBadge(w: ReturnType<typeof window_>): number {
            return avatarBadgeOf(w.store.get(w.sources.rows).items, w.hub.getView().badge, DefaultVisitSettings).count;
        }

        it("an agent that finished while the panel was open leaves the face's badge when its Done card is archived", () => {
            const w = window_({ card: true });
            w.store.set(w.sources.agents, states(agent("a", "working")));
            // Its Done card is listed from the moment it finishes (the same reading of the agent states).
            w.store.set(w.sources.openDone, new Set(["a"]));
            w.store.set(w.sources.agents, states(agent("a", "done")));
            expect(faceBadge(w)).toBe(1);
            // The developer archives the Done card: nothing is left unseen, so the face shows no "1".
            w.store.set(w.sources.openDone, new Set());
            expect(faceBadge(w)).toBe(0);
        });

        it("Archive all leaves the badge at the rows still unseen, never one more", () => {
            const w = window_({ card: true });
            w.store.set(w.sources.agents, states(agent("a", "working"), agent("b", "working")));
            w.store.set(w.sources.openDone, new Set(["a", "b"]));
            w.store.set(w.sources.agents, states(agent("a", "done"), agent("b", "done")));
            w.list(item("agent:c", "waiting", T - 1 * Min), item("ci:/p:1", "error", T - 1 * Min));
            expect(faceBadge(w)).toBe(4);
            w.list(item("ci:/p:1", "error", T - 1 * Min));
            w.store.set(w.sources.openDone, new Set());
            expect(faceBadge(w)).toBe(1);
        });

        it("the undo gives a row back as heard: he does not come for it", () => {
            const w = window_();
            w.list(item("agent:a", "waiting", T - 6 * Min));
            w.store.set(w.sources.card, true);
            expect(w.hub.getView().visit).toBeNull();
            w.list();
            w.store.set(w.sources.card, false);
            w.list(item("agent:a", "waiting", T - 6 * Min));
            w.hub.heard(["agent:a"]);
            expect(w.hub.getView().visit).toBeNull();
            expect(w.hub.getView().cue).toBe(false);
            expect(faceBadge(w)).toBe(1);
        });
    });

    it("stops listening", () => {
        const w = window_();
        w.stop();
        w.list(item("agent:a", "waiting", T - 6 * Min));
        expect(w.hub.getView().visit).toBeNull();
    });
});

describe("Brokk's switch reaches the hub (FR-BOSS-009, #2218)", () => {
    it("folds the visit that is up when he is turned off, and keeps feeding the badge's keys", () => {
        const w = window_();
        w.list(item("agent:a", "waiting", T - 6 * Min));
        expect(w.hub.getView().visit).not.toBeNull();
        w.store.set(w.sources.on, false);
        expect(w.hub.getView().visit).toBeNull();
        w.list(item("agent:a", "waiting", T - 6 * Min), item("agent:b", "error", T - Min));
        expect(w.hub.getView().visit).toBeNull();
        expect(w.hub.getView().badgeKeys).toEqual(["agent:a", "agent:b"]);
    });

    it("raises nothing for what is already there when the window starts with him off", () => {
        const w = window_({ on: false, rows: [item("agent:a", "waiting", T - 6 * Min)] });
        expect(w.hub.getView().visit).toBeNull();
        expect(w.hub.getView().badgeKeys).toEqual(["agent:a"]);
        w.store.set(w.sources.on, true);
        expect(w.hub.getView().visit).not.toBeNull();
    });
});
