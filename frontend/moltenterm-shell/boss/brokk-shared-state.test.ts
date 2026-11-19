// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { DownloadRecord } from "../downloads/downloads-model";
import type { MoltentermNotification } from "../notifications-model";
import { readHandled } from "./boss-handled";
import { buildToHandle, ToHandleList } from "./boss-to-handle-model";
import { BrokkHub } from "./brokk-hub";
import { avatarBadgeOf } from "./brokk-hub-feed";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import {
    clearParked,
    HandledMetaKey,
    HeardMetaKey,
    MarksMeta,
    parkedKeysOf,
    ParkedMetaKey,
    parkedText,
    parkRow,
    readHeard,
    readParked,
} from "./brokk-marks";
import { DefaultVisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

// Brokk's badge is the same in every workspace (FR-BOSS-009, AC105, AC106, #2391). Each workspace shows a page of its own,
// with its own store and its own hub; what the app holds (the agent states, the notifications, the downloads) reaches
// each page, and what the developer did with Brokk is the client's meta, which every page reads.

const T = new Date(2026, 10, 19, 10, 0, 0).getTime();

function agent(blockid: string, state: AgentStateInfo["state"], since: number): AgentStateInfo {
    return { blockid, agent: "claude", firstname: blockid, workspaceid: "w1", state, version: 1, since };
}

function warning(id: string, over: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id,
        key: id,
        source: "moltenterm",
        kind: "warning",
        title: `Check ${id}`,
        time: T,
        ...over,
    } as MoltentermNotification;
}

type Page = { sync: () => void };

// The app: its facts, the client's meta and the clock.
function app() {
    const clock = { now: T };
    const facts = {
        agents: { states: {}, versions: {} } as AgentStatesData,
        notifications: [] as MoltentermNotification[],
        downloads: [] as DownloadRecord[],
    };
    const meta: MarksMeta = { [HeardMetaKey]: T - 60000 };
    const pages: Page[] = [];
    const tell = () => pages.forEach((p) => p.sync());
    return {
        clock,
        facts,
        meta,
        pages,
        setAgents: (...infos: AgentStateInfo[]) => {
            facts.agents = { states: Object.fromEntries(infos.map((i) => [i.blockid, i])), versions: {} };
            tell();
        },
        setNotifications: (...entries: MoltentermNotification[]) => {
            facts.notifications = entries;
            tell();
        },
        setDownloads: (...items: DownloadRecord[]) => {
            facts.downloads = items;
            tell();
        },
        writeMeta: (patch: MarksMeta) => {
            Object.assign(meta, patch);
            tell();
        },
    };
}

type App = ReturnType<typeof app>;

// One workspace's page, wired as brokk-hub-store.ts and boss-store.ts wire it, on a store of its own.
function page(a: App) {
    const store = createStore();
    const agents = atom(a.facts.agents) as PrimitiveAtom<AgentStatesData>;
    const notifications = atom(a.facts.notifications) as PrimitiveAtom<MoltentermNotification[]>;
    const downloads = atom(a.facts.downloads) as PrimitiveAtom<DownloadRecord[]>;
    const meta = atom({ ...a.meta }) as PrimitiveAtom<MarksMeta>;
    const cardOpen = atom(false) as PrimitiveAtom<boolean>;
    const toHandle = atom(
        (get): ToHandleList =>
            buildToHandle({
                states: get(agents),
                notifications: get(notifications),
                answers: {},
                readied: {},
                sessions: [],
                parked: parkedKeysOf(readParked(get(meta)[ParkedMetaKey])),
                handled: readHandled(get(meta)[HandledMetaKey], a.clock.now),
                handoffs: [],
            })
    );
    const hub = new BrokkHub({
        now: () => a.clock.now,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => store.get(cardOpen),
        openPanel: () => store.set(cardOpen, true),
        readShared: () => EmptyShared,
        writeShared: () => {},
    });
    feedBrokkHub(hub, {
        store,
        agentsAtom: agents,
        agentsLoadedAtom: atom(true),
        toHandleAtom: toHandle,
        settingsAtom: atom(DefaultVisitSettings),
        sidebarOnScreenAtom: atom(true),
        searchOpenAtom: atom(false),
        dragAtom: atom(false),
        cardOpenAtom: cardOpen,
        downloadsAtom: downloads,
        heardAtAtom: atom((get) => readHeard(get(meta)[HeardMetaKey])),
        sharedAtom: meta,
    });
    const p = {
        sync: () => {
            store.set(agents, a.facts.agents);
            store.set(notifications, a.facts.notifications);
            store.set(downloads, a.facts.downloads);
            store.set(meta, { ...a.meta });
        },
        // The face's badge, as the avatar draws it (use-brokk-hub.ts useAvatarBadge).
        badge: () => avatarBadgeOf(store.get(toHandle).items, hub.getView().badge, DefaultVisitSettings).count,
        rows: () => store.get(toHandle).items.map((item) => item.key),
        // The developer opens his group in this page (boss-store.ts openCard).
        open: () => {
            a.writeMeta({
                [HeardMetaKey]: a.clock.now,
                [ParkedMetaKey]: parkedText(clearParked(readParked(a.meta[ParkedMetaKey]), a.clock.now)),
            });
            store.set(cardOpen, true);
            store.set(cardOpen, false);
        },
        later: (key: string) =>
            a.writeMeta({ [ParkedMetaKey]: parkedText(parkRow(readParked(a.meta[ParkedMetaKey]), key, a.clock.now)) }),
    };
    a.pages.push(p);
    return p;
}

describe("one badge in every workspace (FR-BOSS-009, AC105, AC106, #2391)", () => {
    it("counts the same notifications the same in two pages", () => {
        const a = app();
        const one = page(a);
        const two = page(a);
        a.setNotifications(warning("n1"), warning("n2"));
        expect(one.badge()).toBe(2);
        expect(two.badge()).toBe(2);
    });

    it("counts an agent that finished in every page, whichever page saw it finish, until his group is opened", () => {
        const a = app();
        const watching = page(a);
        a.setAgents(agent("a", "working", T - 5000));
        a.clock.now = T + 1000;
        a.setAgents(agent("a", "done", T + 1000));
        // A page that loads after the finish (another workspace shown for the first time) counts it too.
        const later = page(a);
        expect(watching.badge()).toBe(1);
        expect(later.badge()).toBe(1);
        a.clock.now = T + 2000;
        later.open();
        expect(watching.badge()).toBe(0);
        expect(later.badge()).toBe(0);
    });

    it("shows a row set aside, seen or done in page A the same in page B", () => {
        const a = app();
        const one = page(a);
        const two = page(a);
        a.setNotifications(warning("n1"), warning("n2"), warning("n3"));
        expect(two.badge()).toBe(3);

        one.later("notif:n1");
        expect(one.rows()).toEqual(two.rows());
        expect(two.rows()).not.toContain("notif:n1");
        expect(two.badge()).toBe(2);

        // Seen: going there read it; done: it resolved. Both are the notification's, which every page holds.
        a.setNotifications(warning("n1"), warning("n2", { read: true }), warning("n3", { resolved: T + 1 }));
        expect(one.badge()).toBe(two.badge());
        expect(two.badge()).toBe(0);

        // Opened in page B, the row set aside comes back in both.
        a.clock.now = T + 5000;
        two.open();
        expect(one.rows()).toContain("notif:n1");
        expect(one.badge()).toBe(1);
        expect(two.badge()).toBe(1);
    });

    it("counts a notification raised while page B was hidden the same once B shows", () => {
        const a = app();
        const one = page(a);
        a.setNotifications(warning("n1"));
        a.setDownloads({ id: "d1", state: "completed", endedAt: T - 1000 } as DownloadRecord);
        // B's page comes after: it was not there, or its timers slept, while these came.
        const two = page(a);
        expect(two.badge()).toBe(one.badge());
        expect(two.badge()).toBe(2);
    });

    it("never counts twice what a page reloaded reads again", () => {
        const a = app();
        const one = page(a);
        a.setNotifications(warning("n1"));
        a.setAgents(agent("a", "done", T + 1));
        const reloaded = page(a);
        reloaded.sync();
        expect(one.badge()).toBe(2);
        expect(reloaded.badge()).toBe(2);
    });
});
