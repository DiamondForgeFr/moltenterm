// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    addUpdate,
    formatAge,
    makeNotificationId,
    MaxNotifications,
    MoltentermNotification,
    notificationLocation,
    notificationTabToActivate,
    parseNotifications,
    readAllUpdate,
    readUpdate,
    unreadByWorkspace,
} from "./notifications-model";

function entry(id: string, time: number, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return { id, time, title: `t${id}`, source: "agent", kind: "info", read: false, ...extra };
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
        expect(addUpdate([], { source: "agent", title: "Waiting", workspaceid: "w1" }, 100, "x")).toEqual({
            "molten:notif:x": {
                source: "agent",
                title: "Waiting",
                workspaceid: "w1",
                kind: "info",
                time: 100,
                read: false,
            },
        });
    });

    it("drops the oldest entries beyond the cap", () => {
        const existing = Array.from({ length: MaxNotifications }, (_, i) => entry(`e${i}`, i));
        const update = addUpdate(existing, { source: "agent", title: "new" }, 10000, "new");
        expect(update["molten:notif:e0"]).toBeNull();
        expect(update["molten:notif:e1"]).toBeUndefined();
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
