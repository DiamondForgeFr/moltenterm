// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import type { MoltentermNotification } from "../notifications-model";
import type { ToHandleList } from "./boss-to-handle-model";
import type { UsageReadings } from "./boss-usage";
import { listedUpdateCard } from "./brokk-extra-feeds";
import { badgeShares } from "./brokk-group-model";
import { BrokkHub } from "./brokk-hub";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import { buildNotes, noteFacts } from "./brokk-notes-model";
import { comingChoices, comingOf, DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

const T = new Date(2026, 10, 11, 10, 0, 0).getTime();
const CardKey = "update:available:12";
const NoRows: ToHandleList = { items: [], info: [], parked: 0 };

function card(over: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id: "n1",
        key: CardKey,
        source: "moltenterm",
        kind: "info",
        title: "Build 12 is ready",
        time: T,
        ...over,
    } as MoltentermNotification;
}

// The app's own stores, which every workspace reads: the notification centre and the update on offer.
function app() {
    const store = createStore();
    return {
        store,
        entries: atom([] as MoltentermNotification[]) as PrimitiveAtom<MoltentermNotification[]>,
        offer: atom("") as PrimitiveAtom<string>,
        usage: atom({} as UsageReadings) as PrimitiveAtom<UsageReadings>,
    };
}

type App = ReturnType<typeof app>;

// One workspace's window: its own hub, fed from the app's stores as brokk-hub-store.ts feeds it.
function workspace(a: App, settings: VisitSettings = DefaultVisitSettings) {
    const cardOpen = atom(false) as PrimitiveAtom<boolean>;
    const hub = new BrokkHub({
        now: () => T + 1000,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => a.store.get(cardOpen),
        openPanel: () => a.store.set(cardOpen, true),
        readShared: () => EmptyShared,
        writeShared: () => {},
    });
    feedBrokkHub(hub, {
        store: a.store,
        agentsAtom: atom({ states: {}, versions: {} } as AgentStatesData),
        agentsLoadedAtom: atom(true),
        toHandleAtom: atom(NoRows),
        settingsAtom: atom(settings),
        sidebarOnScreenAtom: atom(true),
        searchOpenAtom: atom(false),
        dragAtom: atom(false),
        cardOpenAtom: cardOpen,
        updateOfferAtom: atom((get) => listedUpdateCard(get(a.offer), get(a.entries))),
        usageAtom: a.usage,
    });
    // What the Notifications panel lists there when it opens, and what the face counts for it.
    const listed = () => buildNotes({ toHandle: NoRows, entries: a.store.get(a.entries), settings, now: T });
    const faceCount = () => badgeShares(hub.getView().badgeKeys).notifications;
    const open = () => {
        a.store.set(cardOpen, true);
        a.store.set(cardOpen, false);
    };
    return { hub, listed, faceCount, open };
}

describe("Brokk's badge counts what his panel lists, in every workspace (#2213)", () => {
    it("shows no badge in any workspace for an update whose card was archived", () => {
        const a = app();
        const opened = workspace(a);
        const other = workspace(a);
        a.store.set(a.offer, CardKey);
        a.store.set(a.entries, [card()]);
        expect(opened.faceCount()).toBe(1);
        expect(other.faceCount()).toBe(1);
        expect(other.listed()).toHaveLength(1);
        // Opened in one workspace, the card then archived: the offer still stands in both.
        opened.open();
        a.store.set(a.entries, [card({ archived: T + 2000 })]);
        for (const w of [opened, other]) {
            expect(w.listed()).toHaveLength(0);
            expect(w.faceCount()).toBe(0);
            expect(w.hub.getView().badge).toBe(0);
        }
    });

    it("leaves the badge once the card is read or settled", () => {
        const a = app();
        const w = workspace(a);
        a.store.set(a.offer, CardKey);
        a.store.set(a.entries, [card({ read: true })]);
        expect(w.faceCount()).toBe(0);
        a.store.set(a.entries, [card({ resolved: T + 1 })]);
        expect(w.faceCount()).toBe(0);
    });

    it("never counts the plan usage, which has no card, in any workspace", () => {
        const a = app();
        // Set to Badge by an older version: still nothing to count.
        const older: VisitSettings = {
            ...DefaultVisitSettings,
            coming: { ...DefaultVisitSettings.coming, usage: "badge" },
        };
        const fresh = workspace(a, older);
        const hot: UsageReadings = {
            claude: { agent: "claude", source: "t", readat: T, windows: [{ id: "w", label: "w", usedpercent: 95 }] },
        };
        a.store.set(a.usage, hot);
        const later = workspace(a, older);
        for (const w of [fresh, later]) {
            expect(w.listed()).toHaveLength(0);
            expect(noteFacts(w.listed()).count).toBe(0);
            expect(w.hub.getView().badge).toBe(0);
        }
    });
});

describe("listedUpdateCard (#2213)", () => {
    it("names the card only while it is listed unread", () => {
        expect(listedUpdateCard(CardKey, [card()])).toBe(CardKey);
        expect(listedUpdateCard(CardKey, [card({ read: true })])).toBe("");
        expect(listedUpdateCard(CardKey, [card({ resolved: T })])).toBe("");
        expect(listedUpdateCard(CardKey, [card({ archived: T })])).toBe("");
        expect(listedUpdateCard(CardKey, [])).toBe("");
        expect(listedUpdateCard("", [card()])).toBe("");
    });
});

describe("the plan usage row of the table (#2213)", () => {
    it("offers Comes or Nothing, and reads an older Badge as Nothing", () => {
        expect(comingChoices("usage")).toEqual(["vient", "rien"]);
        const old = { ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, usage: "badge" as const } };
        expect(comingOf("usage", old)).toBe("rien");
        expect(comingOf("usage", DefaultVisitSettings)).toBe("rien");
        expect(comingChoices("finished")).toEqual(["badge", "rien"]);
        expect(comingChoices("update")).toEqual(["vient", "badge", "rien"]);
    });
});
