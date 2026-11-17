// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import type { ToHandleList } from "./boss-to-handle-model";
import type { UsageReadings } from "./boss-usage";
import { BrokkHub } from "./brokk-hub";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import type { UsageContext } from "./brokk-usage-model";
import { DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

const T = new Date(2026, 10, 6, 14, 0, 0).getTime();

function windowWith(settings: VisitSettings) {
    const store = createStore();
    const usage = atom({} as UsageReadings) as PrimitiveAtom<UsageReadings>;
    const usageContext = atom({} as UsageContext) as PrimitiveAtom<UsageContext>;
    const card = atom(false) as PrimitiveAtom<boolean>;
    const hub = new BrokkHub({
        now: () => T + 1000,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => store.get(card),
        openPanel: () => store.set(card, true),
        readShared: () => EmptyShared,
        writeShared: () => {},
    });
    feedBrokkHub(hub, {
        store,
        agentsAtom: atom({ states: {}, versions: {} } as AgentStatesData),
        agentsLoadedAtom: atom(true),
        toHandleAtom: atom({ items: [], info: [], parked: 0 } as ToHandleList),
        settingsAtom: atom(settings),
        sidebarOnScreenAtom: atom(true),
        searchOpenAtom: atom(false),
        dragAtom: atom(false),
        cardOpenAtom: card,
        usageAtom: usage,
        usageContextAtom: usageContext,
    });
    return { store, usage, usageContext, hub };
}

const hot = (): UsageReadings => ({
    claude: { agent: "claude", source: "t", readat: Date.now(), windows: [{ id: "w", label: "w", usedpercent: 96 }] },
});

// FR-BOSS-009, AC11 (#2341): the rules that tell which plan usage calls him are not loaded with the window (NFR-PERF-003,
// bundle.initialJsMB): the first reading loads them and is told once they are there. This file does not load them first.
describe("the rules of the plan usage visit load when a reading first comes", () => {
    it("tells a hot reading once the rules are loaded, and the next change in the event that brought it", async () => {
        const w = windowWith({ ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, usage: "vient" } });
        w.store.set(w.usageContext, { use: {}, choices: { show: [], hide: [] } });
        expect(w.hub.getView().visit).toBeNull();
        w.store.set(w.usage, hot());
        // The rules are not there yet: nothing is told in this event, and it is told when they arrive.
        expect(w.hub.getView().visit).toBeNull();
        await vi.waitFor(() => expect(w.hub.getView().visit).not.toBeNull(), { timeout: 30000 });
        // They are there now: hiding the provider calls him off in the very event that hid it.
        w.store.set(w.usageContext, { use: {}, choices: { show: [], hide: ["claude"] } });
        expect(w.hub.getView().visit).toBeNull();
    });
});
