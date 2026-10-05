// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    activeEntries,
    archivedEntries,
    archiveResolvedUpdate,
    archiveUpdate,
    clearArchiveUpdate,
    ClosedRetentionMs,
    formatAge,
    makeNotificationId,
    MaxClosedPerKey,
    MaxNotifications,
    MoltentermNotification,
    NotificationAction,
    notificationLocation,
    notificationTabToActivate,
    openCount,
    parseNotifications,
    pruneIds,
    publishUpdate,
    readAllUpdate,
    readUpdate,
    resolveUpdate,
    unreadByWorkspace,
    unreadCount,
    visibleActions,
} from "./notifications-model";

function entry(id: string, time: number, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return { id, time, updated: time, title: `t${id}`, source: "agent", kind: "info", read: false, ...extra };
}

describe("parseNotifications", () => {
    it("reads only valid notification keys, newest first", () => {
        const list = parseNotifications({
            "molten:notif:a": { title: "A", time: 10, source: "agent" },
            "molten:notif:b": { title: "B", time: 30, source: "mod", kind: "error", read: true },
            "molten:notif:c": null,
            "molten:notif:d": { title: 3, time: 1 },
            "other:key": { title: "X", time: 99 },
        });
        expect(list.map((e) => [e.id, e.kind, e.read])).toEqual([
            ["b", "error", true],
            ["a", "info", false],
        ]);
    });

    it("copes with a client without meta", () => {
        expect(parseNotifications(undefined)).toEqual([]);
    });
});

describe("unreadByWorkspace", () => {
    it("counts unread entries per workspace", () => {
        const counts = unreadByWorkspace([
            entry("1", 1, { workspaceid: "w1" }),
            entry("2", 2, { workspaceid: "w1" }),
            entry("3", 3, { workspaceid: "w1", read: true }),
            entry("4", 4, { workspaceid: "w2" }),
            entry("5", 5),
        ]);
        expect([...counts.entries()]).toEqual([
            ["w1", 2],
            ["w2", 1],
        ]);
    });
});

describe("updates", () => {
    it("adds one entry with its time", () => {
        expect(publishUpdate([], { source: "agent", title: "Waiting", workspaceid: "w1" }, 100, "x")).toEqual({
            "molten:notif:x": {
                source: "agent",
                title: "Waiting",
                workspaceid: "w1",
                kind: "info",
                actions: [],
                time: 100,
                updated: 100,
                read: false,
            },
        });
    });

    it("drops the oldest closed entries beyond the cap, never an open one", () => {
        const existing = Array.from({ length: MaxNotifications }, (_, i) => entry(`e${i}`, i, { read: i > 0 }));
        const update = publishUpdate(existing, { source: "agent", title: "new" }, 10000, "new");
        expect(update["molten:notif:e0"]).toBeUndefined();
        expect(update["molten:notif:e1"]).toBeNull();
        expect(Object.keys(update)).toHaveLength(2);
    });

    it("marks given entries read, and all of them", () => {
        const list = [entry("a", 1), entry("b", 2), entry("c", 3, { read: true })];
        expect(Object.keys(readUpdate(list, ["a", "c"]))).toEqual(["molten:notif:a"]);
        expect(readUpdate(list, ["a"])["molten:notif:a"]).toMatchObject({ read: true, title: "ta", time: 1 });
        expect(readUpdate(list, ["a"])["molten:notif:a"].id).toBeUndefined();
        expect(Object.keys(readAllUpdate(list)).sort()).toEqual(["molten:notif:a", "molten:notif:b"]);
    });
});

describe("situations (FR-MC-010)", () => {
    const reveal: NotificationAction = {
        id: "reveal",
        label: "Show in Finder",
        kind: "gesture",
        gesture: "path:reveal",
        lasting: true,
    };
    const timeline: NotificationAction = {
        id: "open",
        label: "Show the build",
        kind: "open",
        view: "molten-project",
    };
    const ready = (message = "Build 9c425c4") => ({
        key: "build:gold",
        source: "build" as const,
        title: "MoltenTerm Gold is ready",
        message,
        actions: [reveal, timeline],
    });

    it("updates the open notification of a key instead of adding one", () => {
        const first = entry("a", 10, { ...ready(), read: true, actions: [reveal, timeline] });
        expect(publishUpdate([first], ready(), 20, "b")).toBeNull();
        const update = publishUpdate([first], ready("Build 1234567"), 30, "b");
        expect(Object.keys(update)).toEqual(["molten:notif:a"]);
        expect(update["molten:notif:a"]).toMatchObject({
            message: "Build 1234567",
            read: false,
            time: 10,
            updated: 30,
        });
    });

    it("starts a new notification once the previous one of the key is resolved", () => {
        const first = entry("a", 10, { ...ready(), resolved: 15 });
        expect(Object.keys(publishUpdate([first], ready(), 20, "b"))).toEqual(["molten:notif:b"]);
    });

    it("keeps at most two actions", () => {
        const update = publishUpdate([], { ...ready(), actions: [reveal, timeline, { ...timeline, id: "x" }] }, 1, "a");
        expect(update["molten:notif:a"].actions.map((a: NotificationAction) => a.id)).toEqual(["reveal", "open"]);
    });

    it("resolves a key, keeping only lasting actions", () => {
        const list = [entry("a", 1, ready()), entry("b", 2, { ...ready(), key: "other" })];
        const update = resolveUpdate(list, "build:gold", 50);
        expect(Object.keys(update)).toEqual(["molten:notif:a"]);
        const resolved = { ...list[0], ...update["molten:notif:a"], id: "a" } as MoltentermNotification;
        expect(resolved.resolved).toBe(50);
        expect(visibleActions(resolved).map((a) => a.id)).toEqual(["reveal"]);
        expect(visibleActions(list[0]).map((a) => a.id)).toEqual(["reveal", "open"]);
    });

    it("archives, keeps the first date, archives the resolved, clears the archive", () => {
        const list = [entry("a", 1), entry("b", 2, { archived: 5 }), entry("c", 3, { resolved: 4 })];
        expect(Object.keys(archiveUpdate(list, ["a", "b"], 9))).toEqual(["molten:notif:a"]);
        expect(archiveUpdate(list, ["a"], 9)["molten:notif:a"]).toMatchObject({ archived: 9, read: true });
        expect(Object.keys(archiveResolvedUpdate(list, 9))).toEqual(["molten:notif:c"]);
        expect(clearArchiveUpdate(list)).toEqual({ "molten:notif:b": null });
        expect(activeEntries(list).map((e) => e.id)).toEqual(["a", "c"]);
        expect(archivedEntries(list).map((e) => e.id)).toEqual(["b"]);
    });

    it("counts unread and still-open situations for the bell", () => {
        const list = [
            entry("a", 1),
            entry("b", 2, { key: "k", read: true }),
            entry("c", 3, { key: "k2", read: true, resolved: 4 }),
            entry("d", 4, { archived: 5 }),
            entry("e", 5, { read: true }),
        ];
        expect(unreadCount(list)).toBe(1);
        expect(openCount(list)).toBe(1);
    });

    it("drops closed entries after 30 days or beyond 20 per key, never open ones", () => {
        const now = ClosedRetentionMs + 1000;
        const old = entry("old", 1, { read: true });
        const openOld = entry("openOld", 1, { key: "k", read: true });
        const closed = Array.from({ length: MaxClosedPerKey + 2 }, (_, i) =>
            entry(`r${i}`, now - 100 + i, { key: "same", resolved: now - 100 + i })
        );
        const drop = pruneIds([old, openOld, ...closed], now);
        expect(drop.sort()).toEqual(["old", "r0", "r1"]);
    });

    it("reads back actions, dropping malformed ones", () => {
        const [read] = parseNotifications({
            "molten:notif:a": {
                title: "A",
                time: 1,
                source: "build",
                actions: [reveal, { id: "x", label: "X", kind: "gesture" }, { id: 3 }, timeline],
            },
        });
        expect(read.actions.map((a) => a.id)).toEqual(["reveal", "open"]);
        expect(read.updated).toBe(1);
    });
});

describe("helpers", () => {
    it("makes sortable unique ids", () => {
        expect(makeNotificationId(36, () => 0)).toBe("10-000000");
    });

    it("formats ages", () => {
        expect(formatAge(0, 30_000)).toBe("now");
        expect(formatAge(0, 5 * 60_000)).toBe("5 min");
        expect(formatAge(0, 3 * 3600_000)).toBe("3 h");
        expect(formatAge(0, 49 * 3600_000)).toBe("2 d");
    });
});

describe("location (#80)", () => {
    const shown = { oid: "wsB", tabids: ["b1", "b2"] };

    it("places a notification in the view's tab and the shown workspace", () => {
        expect(notificationLocation({ source: "moltenterm", title: "t" }, shown, "b2")).toEqual({
            workspaceid: "wsB",
            tabid: "b2",
        });
    });

    it("never pairs the shown workspace with the tab of a view kept for another workspace", () => {
        expect(notificationLocation({ source: "moltenterm", title: "t" }, shown, "a1")).toEqual({
            workspaceid: undefined,
            tabid: undefined,
        });
        expect(notificationLocation({ source: "agent", title: "t", tabid: "a1" }, shown, "b1")).toEqual({
            workspaceid: undefined,
            tabid: "a1",
        });
        expect(notificationLocation({ source: "agent", title: "t", workspaceid: "wsA" }, shown, "b1")).toEqual({
            workspaceid: "wsA",
            tabid: undefined,
        });
    });

    it("keeps an explicit location", () => {
        expect(
            notificationLocation({ source: "agent", title: "t", workspaceid: "wsA", tabid: "a1" }, shown, "b1")
        ).toEqual({ workspaceid: "wsA", tabid: "a1" });
    });

    it("copes without a shown workspace", () => {
        expect(notificationLocation({ source: "mod", title: "t" }, null, "b1")).toEqual({
            workspaceid: undefined,
            tabid: undefined,
        });
    });

    it("activates only one of the shown workspace's tabs", () => {
        expect(notificationTabToActivate(entry("1", 1, { tabid: "b2" }), shown, "b1")).toBe("b2");
        expect(notificationTabToActivate(entry("1", 1, { tabid: "b1" }), shown, "b1")).toBeNull();
        expect(notificationTabToActivate(entry("1", 1, { tabid: "a1", workspaceid: "wsB" }), shown, "b1")).toBeNull();
        expect(notificationTabToActivate(entry("1", 1), shown, "b1")).toBeNull();
    });
});
