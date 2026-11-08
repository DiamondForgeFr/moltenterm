// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { I18nModel } from "./i18n/i18n";
import { translate } from "./i18n/i18n-core";
import {
    activeEntries,
    archivedEntries,
    archiveResolvedUpdate,
    archiveUpdate,
    clearArchiveUpdate,
    clearedMarks,
    ClosedRetentionMs,
    formatAge,
    handledUpdate,
    makeNotificationId,
    MaxClosedPerKey,
    MaxNotifications,
    MoltentermNotification,
    NotificationAction,
    notificationActionLabel,
    notificationLocation,
    notificationMessage,
    notificationTabToActivate,
    notificationTitle,
    openCount,
    parseNotifications,
    pruneIds,
    publishUpdate,
    readAllUpdate,
    readUpdate,
    resolveUpdate,
    rowKeyAction,
    undoClearUpdate,
    unreadByWorkspace,
    unreadCount,
    visibleActions,
} from "./notifications-model";
import { goneNotificationToasts, Toast } from "./toast-model";

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

    it("folds an agent's outdated waiting entry into its newer one (#748)", () => {
        const waiting = entry("w", 1, { kind: "warning", blockid: "b1" });
        const otherBlock = entry("o", 2, { kind: "warning", blockid: "b2" });
        const shell = entry("s", 3, { kind: "warning", blockid: "b1", source: "sessions" });
        const done = { source: "agent" as const, kind: "success" as const, title: "Done", blockid: "b1" };
        const update = publishUpdate([waiting, otherBlock, shell], done, 10, "d");
        expect(Object.keys(update).sort()).toEqual(["molten:notif:d", "molten:notif:w"]);
        expect(update["molten:notif:w"]).toMatchObject({ resolved: 10, archived: 10, read: true, title: "tw" });
        const folded = parseNotifications(update).find((e) => e.id === "w");
        expect(visibleActions({ ...folded, actions: [{ id: "a", label: "A", kind: "open" }] })).toEqual([]);
        expect(Object.keys(publishUpdate([waiting], { ...done, blockid: "b2" }, 10, "d"))).toEqual(["molten:notif:d"]);
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

    it("keeps at most three actions", () => {
        const actions = [reveal, timeline, { ...timeline, id: "x" }, { ...timeline, id: "y" }];
        const update = publishUpdate([], { ...ready(), actions }, 1, "a");
        expect(update["molten:notif:a"].actions.map((a: NotificationAction) => a.id)).toEqual(["reveal", "open", "x"]);
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

    it("settles a notification: resolved, filed and read at once, whatever its key, and only once (#2026)", () => {
        const list = [
            entry("a", 1, { key: "k" }),
            entry("b", 2),
            entry("c", 3, { resolved: 4 }),
            entry("d", 4, { archived: 5, resolved: 5 }),
        ];
        const update = handledUpdate(list, ["a", "b", "c", "d", "gone"], 9);
        expect(Object.keys(update).sort()).toEqual(["molten:notif:a", "molten:notif:b", "molten:notif:c"]);
        expect(update["molten:notif:a"]).toMatchObject({ resolved: 9, archived: 9, read: true });
        expect(update["molten:notif:c"]).toMatchObject({ resolved: 4, archived: 9, read: true });
        const settled = { ...list[0], ...update["molten:notif:a"], id: "a" } as MoltentermNotification;
        expect(activeEntries([settled])).toEqual([]);
        expect(unreadCount([settled])).toBe(0);
    });

    it("takes a toast away once its notification is settled", () => {
        const stack = [{ id: "notif:a", notificationId: "a" }] as Toast[];
        const list = [entry("a", 1)];
        expect(goneNotificationToasts(stack, list)).toEqual([]);
        const settled = { ...list[0], ...handledUpdate(list, ["a"], 9)["molten:notif:a"] } as MoltentermNotification;
        expect(goneNotificationToasts(stack, [settled])).toEqual(["notif:a"]);
    });

    it("gives back a cleared notification as it was, and only while it stays as it was cleared (#2026)", () => {
        const list = [entry("a", 1), entry("b", 2, { read: true }), entry("c", 3, { resolved: 4, read: true })];
        const marks = clearedMarks(list, ["a", "b", "c", "gone"]);
        expect(marks).toEqual([
            { id: "a", read: false, resolved: undefined },
            { id: "b", read: true, resolved: undefined },
            { id: "c", read: true, resolved: 4 },
        ]);
        const cleared = list.map((e) => ({ ...e, ...archiveUpdate(list, ["a", "b", "c"], 9)["molten:notif:" + e.id] }));
        const undo = undoClearUpdate(cleared as MoltentermNotification[], marks, 9);
        expect(undo["molten:notif:a"]).not.toHaveProperty("archived");
        expect(undo["molten:notif:a"]).toMatchObject({ read: false });
        expect(undo["molten:notif:c"]).toMatchObject({ read: true, resolved: 4 });
        expect(undoClearUpdate(cleared as MoltentermNotification[], marks, 8)).toEqual({});
        const changed = cleared.map((e) => (e.id === "b" ? { ...e, archived: 12 } : e)) as MoltentermNotification[];
        expect(Object.keys(undoClearUpdate(changed, marks, 9)).sort()).toEqual(["molten:notif:a", "molten:notif:c"]);
    });

    it("answers a key on the focused row: Delete and Backspace clear, Enter and Space open, nothing from a button inside", () => {
        const row = { onRow: true, archived: false, hasOrigin: true };
        expect(rowKeyAction("Delete", row)).toBe("clear");
        expect(rowKeyAction("Backspace", row)).toBe("clear");
        expect(rowKeyAction("Enter", row)).toBe("open");
        expect(rowKeyAction(" ", row)).toBe("open");
        expect(rowKeyAction("Enter", { ...row, hasOrigin: false })).toBeNull();
        expect(rowKeyAction("Delete", { ...row, hasOrigin: false })).toBe("clear");
        expect(rowKeyAction("Delete", { ...row, onRow: false })).toBeNull();
        expect(rowKeyAction("Delete", { ...row, archived: true })).toBeNull();
        expect(rowKeyAction("a", row)).toBeNull();
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

describe("notificationTitle (#727)", () => {
    const fr = (key: string, vars?: Record<string, string>) => translate("fr", key, vars);
    const en = (key: string, vars?: Record<string, string>) => translate("en", key, vars);
    const waiting = { title: "Pauline is waiting for you", titlecode: "agentwaiting", titlevars: { name: "Pauline" } };

    it("translates the agent titles wavesrv sends with a code", () => {
        expect(notificationTitle(waiting, fr)).toBe("Pauline vous attend");
        expect(notificationTitle(waiting, en)).toBe("Pauline is waiting for you");
        const done = { title: "Pauline is done", titlecode: "agentdone", titlevars: { name: "Pauline" } };
        expect(notificationTitle(done, fr)).toBe("Pauline a terminé");
        expect(notificationTitle({ title: "A terminal needs your attention", titlecode: "bell" }, fr)).toBe(
            "Un terminal demande votre attention"
        );
    });

    it("words what wavesrv wrote itself with a code (#656), and leaves an agent's words alone", () => {
        const built = {
            title: "Gold is built",
            titletext: { code: "notif.build.builtTitle", vars: { name: "Gold" } },
            message: "Build 9c425c4 finished.",
            messagetext: { code: "notif.build.finished", vars: { sha: "9c425c4" } },
        };
        const action = { label: "Show in folder", labeltext: { code: "notif.build.showInFolder" } };
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(notificationTitle(built, fr)).toBe("Gold est compilé");
            expect(notificationMessage(built)).toBe("Le build 9c425c4 est terminé.");
            expect(notificationActionLabel(action)).toBe("Afficher dans le dossier");
            expect(notificationMessage({ message: "Done: tests pass" })).toBe("Done: tests pass");
            expect(notificationMessage({})).toBe("");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
        expect(notificationMessage(built)).toBe("Build 9c425c4 finished.");
    });

    it("names a PR by its card's number, the PR number after it only when they differ (#1130)", () => {
        const ticketed = {
            title: "#1107 (PR #1120): CI green again",
            titletext: {
                code: "notif.review.ciGreenTitle",
                vars: { number: "1107" },
                parts: { pr: { code: "notif.review.prAside", vars: { number: "1120" } } },
            },
        };
        const plain = {
            title: "#1120: CI green again",
            titletext: { code: "notif.review.ciGreenTitle", vars: { number: "1120", pr: "" } },
        };
        const conflict = {
            title: "#1107 (PR #1120) needs you: the merge queue stopped on it",
            titletext: {
                code: "notif.review.queue.stoppedTitle",
                vars: { number: "1107" },
                parts: { pr: { code: "notif.review.prAside", vars: { number: "1120" } } },
            },
        };
        expect(notificationTitle(ticketed)).toBe("#1107 (PR #1120): CI green again");
        expect(notificationTitle(plain)).toBe("#1120: CI green again");
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(notificationTitle(ticketed)).toBe("#1107 (PR #1120)\u00a0: la CI est de nouveau verte");
            expect(notificationTitle(plain)).toBe("#1120\u00a0: la CI est de nouveau verte");
            expect(notificationTitle(conflict)).toBe(
                "#1107 (PR #1120) a besoin de vous\u00a0: la file de fusion s'est arrêtée dessus"
            );
            expect(
                notificationActionLabel({ label: "Show in Integration", labeltext: { code: "notif.review.openCard" } })
            ).toBe("Voir dans le panneau Intégration");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });

    it("shows a title without a known code as published", () => {
        expect(notificationTitle({ title: "Claude needs your permission" }, fr)).toBe("Claude needs your permission");
        expect(notificationTitle({ title: "Later", titlecode: "somethingnew" }, fr)).toBe("Later");
        expect(notificationTitle({ title: "Proto", titlecode: "constructor" }, fr)).toBe("Proto");
    });
});
