// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2026 (FR-BOSS-009, AC16): an item that is settled leaves every surface at once. The rows, the badge and the visit
// queue are worked out from the same notifications, agent states and marks, in this window and in the others.

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { DownloadRecord } from "../downloads/downloads-model";
import {
    handledUpdate,
    MoltentermNotification,
    NotificationKeyPrefix,
    parseNotifications,
} from "../notifications-model";
import { EmptyHandled, HandledRows, handledText, markRowHandled, readHandled } from "./boss-handled";
import { buildToHandle, ToHandleList } from "./boss-to-handle-model";
import { closedDownloadIds } from "./brokk-extra-feeds";
import { BrokkHub } from "./brokk-hub";
import { avatarBadgeOf } from "./brokk-hub-feed";
import { feedBrokkHub } from "./brokk-hub-feed-store";
import { DefaultVisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";

const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;

function agent(blockid: string, state: AgentStateInfo["state"], since: number): AgentStateInfo {
    return { blockid, agent: "claude", firstname: blockid, state, version: 1, since } as AgentStateInfo;
}

function states(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((info) => [info.blockid, info])), versions: {} };
}

function notice(id: string, over: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id,
        source: "agent",
        kind: "warning",
        title: `Title ${id}`,
        time: T - 6 * Min,
        updated: T - 6 * Min,
        read: false,
        blockid: "b1",
        actions: [],
        ...over,
    } as MoltentermNotification;
}

// A window as its sources hold it: the notifications and the marks are what the windows share.
function window_(shared: { entries: MoltentermNotification[]; handled: HandledRows }) {
    const store = createStore();
    const agents = atom(states(agent("b1", "waiting", T - 6 * Min))) as PrimitiveAtom<AgentStatesData>;
    const rows = atom({ items: [], info: [], parked: 0 } as ToHandleList) as PrimitiveAtom<ToHandleList>;
    const downloads = atom([] as DownloadRecord[]) as PrimitiveAtom<DownloadRecord[]>;
    const closed = atom<ReadonlySet<string>>(new Set<string>()) as PrimitiveAtom<ReadonlySet<string>>;
    const hub = new BrokkHub({
        now: () => T,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => false,
        openPanel: () => {},
        readShared: () => EmptyShared,
        writeShared: () => {},
    });
    feedBrokkHub(hub, {
        store,
        agentsAtom: agents,
        agentsLoadedAtom: atom(true),
        toHandleAtom: rows,
        settingsAtom: atom(DefaultVisitSettings),
        sidebarOnScreenAtom: atom(true),
        searchOpenAtom: atom(false),
        dragAtom: atom(false),
        cardOpenAtom: atom(false),
        downloadsAtom: downloads,
        closedDownloadsAtom: closed,
    });
    const refresh = () => {
        store.set(
            rows,
            buildToHandle({
                states: store.get(agents),
                notifications: shared.entries.filter((e) => e.archived == null),
                answers: {},
                readied: {},
                sessions: [],
                parked: {},
                handled: shared.handled,
            })
        );
        store.set(closed, closedDownloadIds(shared.entries));
    };
    const badge = () => avatarBadgeOf(store.get(rows).items, hub.getView().badge, DefaultVisitSettings).count;
    refresh();
    return { store, agents, downloads, hub, refresh, badge, rows: () => store.get(rows).items.map((i) => i.key) };
}

// What an update of the client meta does to the notifications.
function applied(entries: MoltentermNotification[], update: Record<string, any>): MoltentermNotification[] {
    const meta = Object.fromEntries(entries.map(({ id, ...value }) => [NotificationKeyPrefix + id, value]));
    for (const [key, value] of Object.entries(update)) {
        if (value == null) {
            delete meta[key];
        } else {
            meta[key] = value;
        }
    }
    return parseNotifications(meta);
}

describe("an item that is settled leaves the badge, the rows and the visit queue (FR-BOSS-009, AC16)", () => {
    it("takes an agent that waits out of the visit and the badge once its row and its notification are settled", () => {
        const shared = { entries: [notice("n1")], handled: EmptyHandled };
        const w = window_(shared);
        expect(w.rows()).toEqual(["agent:b1"]);
        expect(w.hub.getView().visit?.keys).toEqual(["agent:b1"]);
        expect(w.badge()).toBe(1);

        shared.entries = applied(shared.entries, handledUpdate(shared.entries, ["n1"], T));
        shared.handled = markRowHandled(shared.handled, { key: "agent:b1", since: T - 6 * Min, tone: "waiting" }, T);
        w.refresh();
        expect(w.rows()).toEqual([]);
        expect(w.hub.getView().visit).toBeNull();
        expect(w.badge()).toBe(0);
    });

    it("keeps the visit while only the notification is settled: the agent still waits", () => {
        const shared = { entries: [notice("n1")], handled: EmptyHandled };
        const w = window_(shared);
        shared.entries = applied(shared.entries, handledUpdate(shared.entries, ["n1"], T));
        w.refresh();
        expect(w.rows()).toEqual(["agent:b1"]);
        expect(w.hub.getView().visit).not.toBeNull();
    });

    it("takes a question that is no agent's off the badge once its notification is settled", () => {
        const shared = {
            entries: [notice("q1", { blockid: undefined, source: "trust" })],
            handled: EmptyHandled,
        };
        const w = window_(shared);
        w.store.set(w.agents, states());
        w.refresh();
        expect(w.rows()).toEqual(["notif:q1"]);
        expect(w.badge()).toBe(1);
        shared.entries = applied(shared.entries, handledUpdate(shared.entries, ["q1"], T));
        w.refresh();
        expect(w.rows()).toEqual([]);
        expect(w.badge()).toBe(0);
    });

    it("tells the visit of an agent that waits again as news, after it was ignored", () => {
        const shared = { entries: [], handled: EmptyHandled } as {
            entries: MoltentermNotification[];
            handled: HandledRows;
        };
        const w = window_(shared);
        shared.handled = markRowHandled(shared.handled, { key: "agent:b1", since: T - 6 * Min, tone: "waiting" }, T);
        w.refresh();
        expect(w.hub.getView().visit).toBeNull();
        w.store.set(w.agents, states(agent("b1", "working", T)));
        w.refresh();
        w.store.set(w.agents, states(agent("b1", "waiting", T - 5 * Min)));
        w.refresh();
        expect(w.rows()).toEqual(["agent:b1"]);
        expect(w.hub.getView().visit?.keys).toEqual(["agent:b1"]);
    });

    it("takes a download off the badge once its notification is settled or cleared", () => {
        const shared = {
            entries: [notice("d1", { kind: "success", source: "download", key: "download:42", blockid: undefined })],
            handled: EmptyHandled,
        };
        const w = window_(shared);
        w.store.set(w.agents, states());
        w.store.set(w.downloads, [
            { id: "42", state: "completed", endedAt: Date.now() + 1000, name: "a.zip" } as DownloadRecord,
        ]);
        w.refresh();
        expect(w.hub.getView().badge).toBe(1);
        shared.entries = applied(shared.entries, handledUpdate(shared.entries, ["d1"], T));
        w.refresh();
        expect(w.hub.getView().badge).toBe(0);
    });

    it("reaches another window through what the windows share: the notifications and the marks", () => {
        const shared = { entries: [notice("n1")], handled: EmptyHandled };
        const first = window_(shared);
        const second = window_(shared);
        expect(second.hub.getView().visit).not.toBeNull();

        shared.entries = applied(shared.entries, handledUpdate(shared.entries, ["n1"], T));
        shared.handled = markRowHandled(shared.handled, { key: "agent:b1", since: T - 6 * Min, tone: "waiting" }, T);
        first.refresh();
        // The other window reads the marks back from the storage text and the notifications from the client meta.
        const otherSide = { entries: shared.entries, handled: readHandled(handledText(shared.handled), T) };
        const other = window_(otherSide);
        expect(first.hub.getView().visit).toBeNull();
        expect(other.hub.getView().visit).toBeNull();
        expect(other.badge()).toBe(0);
    });
});
