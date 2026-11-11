// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import type { DownloadRecord } from "../downloads/downloads-model";
import type { ToHandleList } from "./boss-to-handle-model";
import type { UsageReadings } from "./boss-usage";
import { BrokkHub } from "./brokk-hub";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import { DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

const T = new Date(2026, 10, 6, 14, 0, 0).getTime();

// The window's sources, with the three of #2003: the downloads, the update on offer and the plan usage.
function window_(settings: VisitSettings = DefaultVisitSettings) {
    const store = createStore();
    const sources = {
        agents: atom({ states: {}, versions: {} } as AgentStatesData) as PrimitiveAtom<AgentStatesData>,
        rows: atom({ items: [], info: [], parked: 0 } as ToHandleList) as PrimitiveAtom<ToHandleList>,
        settings: atom(settings) as PrimitiveAtom<VisitSettings>,
        card: atom(false) as PrimitiveAtom<boolean>,
        downloads: atom([] as DownloadRecord[]) as PrimitiveAtom<DownloadRecord[]>,
        update: atom("") as PrimitiveAtom<string>,
        usage: atom({} as UsageReadings) as PrimitiveAtom<UsageReadings>,
    };
    const hub = new BrokkHub({
        now: () => T + 1000,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => store.get(sources.card),
        openPanel: () => store.set(sources.card, true),
        readShared: () => EmptyShared,
        writeShared: () => {},
    });
    feedBrokkHub(hub, {
        store,
        agentsAtom: sources.agents,
        agentsLoadedAtom: atom(true),
        toHandleAtom: sources.rows,
        settingsAtom: sources.settings,
        sidebarOnScreenAtom: atom(true),
        searchOpenAtom: atom(false),
        dragAtom: atom(false),
        cardOpenAtom: sources.card,
        downloadsAtom: sources.downloads,
        updateOfferAtom: sources.update,
        usageAtom: sources.usage,
    });
    return { store, sources, hub };
}

const vient = (id: "download" | "update" | "usage"): VisitSettings => ({
    ...DefaultVisitSettings,
    coming: { ...DefaultVisitSettings.coming, [id]: "vient" },
});

function done(id: string, state: DownloadRecord["state"]): DownloadRecord {
    return { id, state, endedAt: Date.now() + 60_000 } as DownloadRecord;
}

describe("the downloads, the update notice and the plan usage reach Brokk (FR-BOSS-009, AC11)", () => {
    it("counts a finished download on the badge and brings nothing while its event is set to Badge", () => {
        const w = window_();
        expect(w.hub.getView().badge).toBe(0);
        w.store.set(w.sources.downloads, [done("a", "completed")]);
        expect(w.hub.getView().badge).toBe(1);
        expect(w.hub.getView().visit).toBeNull();
    });

    it("brings him for a failed download when the developer set it to Vient", () => {
        const w = window_(vient("download"));
        w.store.set(w.sources.downloads, [done("a", "interrupted")]);
        expect(w.hub.getView().visit?.severity).toBe("neutre");
    });

    it("counts the update on offer, and brings him when it is set to Vient", () => {
        const badge = window_();
        badge.store.set(badge.sources.update, "gold:12");
        expect(badge.hub.getView().badge).toBe(1);
        const comes = window_(vient("update"));
        comes.store.set(comes.sources.update, "release:1.2.0");
        expect(comes.hub.getView().visit?.severity).toBe("neutre");
    });

    it("brings him for a plan usage that crosses 90 % when it is set to Vient, and never counts it (#2213)", () => {
        const hot: UsageReadings = {
            claude: { agent: "claude", source: "t", readat: T, windows: [{ id: "w", label: "w", usedpercent: 93 }] },
        };
        const badge = window_({
            ...DefaultVisitSettings,
            coming: { ...DefaultVisitSettings.coming, usage: "badge" },
        });
        badge.store.set(badge.sources.usage, hot);
        expect(badge.hub.getView().badge).toBe(0);
        const comes = window_(vient("usage"));
        comes.store.set(comes.sources.usage, hot);
        expect(comes.hub.getView().visit).not.toBeNull();
        expect(comes.hub.getView().badge).toBe(0);
    });

    it("counts nothing for an event set to Rien", () => {
        const w = window_({ ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, download: "rien" } });
        w.store.set(w.sources.downloads, [done("a", "completed")]);
        expect(w.hub.getView().badge).toBe(0);
    });

    it("forgets them all when the developer opens his panel, and tells the next one", () => {
        const w = window_();
        w.store.set(w.sources.downloads, [done("a", "completed")]);
        w.store.set(w.sources.update, "gold:12");
        expect(w.hub.getView().badge).toBe(2);
        w.store.set(w.sources.card, true);
        expect(w.hub.getView().badge).toBe(0);
        w.store.set(w.sources.card, false);
        w.store.set(w.sources.downloads, [done("a", "completed"), done("b", "completed")]);
        expect(w.hub.getView().badge).toBe(1);
    });
});
