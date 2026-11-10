// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { MoltentermNotification } from "../notifications-model";
import { HandledRows, markRowHandled, unmarkRowHandled } from "./boss-handled";
import { buildToHandle, toHandleBadge, ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import {
    archivePlan,
    buildNotes,
    cardGoTo,
    cardTarget,
    consultedIds,
    entrySeverity,
    isPrimaryAction,
    noteFacts,
    NoteRow,
    openDoneBlocks,
    primaryAllowed,
    priorityOf,
    rowSourceId,
    sourceBesideWorkspace,
    todoSeverity,
} from "./brokk-notes-model";
import { DefaultVisitSettings } from "./brokk-visit-events";

const Min = 60 * 1000;
const Now = Date.UTC(2026, 10, 7, 12, 0, 0);

function item(key: string, extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone: "waiting",
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: "" },
        place: "",
        since: Now - 2 * Min,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    };
}

function entry(id: string, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id,
        time: Now - 10 * Min,
        updated: Now - 10 * Min,
        kind: "info",
        read: false,
        title: id,
        ...extra,
    } as MoltentermNotification;
}

function list(items: ToHandleItem[], info: ToHandleList["info"] = []): ToHandleList {
    return { items, info, parked: 0 };
}

function notes(toHandle: ToHandleList, entries: MoltentermNotification[] = [], now = Now): NoteRow[] {
    return buildNotes({ toHandle, entries, settings: DefaultVisitSettings, now });
}

describe("the priority of a row (AC3)", () => {
    it("maps a severity to its marker", () => {
        expect(priorityOf("grave")).toBe("urgent");
        expect(priorityOf("important")).toBe("answer");
        expect(priorityOf("neutre")).toBe("info");
        expect(priorityOf("bonne")).toBe("done");
    });

    it("is À répondre for an agent that waits, Urgent once it waited three times the threshold", () => {
        const waiting = item("agent:b1", { since: Now - 5 * Min });
        expect(todoSeverity(waiting, DefaultVisitSettings, Now)).toBe("important");
        const long = item("agent:b1", { since: Now - 16 * Min });
        expect(todoSeverity(long, DefaultVisitSettings, Now)).toBe("grave");
    });

    it("is À répondre for an agent stopped on an error, a question and a hand-off request", () => {
        expect(todoSeverity(item("agent:b2", { tone: "error" }), DefaultVisitSettings, Now)).toBe("important");
        expect(todoSeverity(item("notif:n1"), DefaultVisitSettings, Now)).toBe("important");
        expect(todoSeverity(item("handoff:r1"), DefaultVisitSettings, Now)).toBe("important");
    });

    it("is Info for a failing CI and Fait for a pull request ready to merge", () => {
        expect(todoSeverity(item("ci:/p:12", { tone: "error" }), DefaultVisitSettings, Now)).toBe("neutre");
        expect(todoSeverity(item("ready:/p:12", { tone: "success" }), DefaultVisitSettings, Now)).toBe("bonne");
    });

    it("is Fait for a success notification and Info for the others", () => {
        expect(entrySeverity(entry("a", { kind: "success" }))).toBe("bonne");
        expect(entrySeverity(entry("b", { kind: "info" }))).toBe("neutre");
        expect(entrySeverity(entry("c", { kind: "error" }))).toBe("neutre");
    });
});

describe("the sort of the Notifications list", () => {
    it("sorts by priority first: Urgent, À répondre, Info, Fait", () => {
        const rows = notes(
            list(
                [
                    item("ready:/p:3", { since: Now - 1 * Min }),
                    item("ci:/p:2", { since: Now - 1 * Min }),
                    item("agent:late", { since: Now - 20 * Min }),
                    item("agent:fresh", { since: Now - 1 * Min }),
                ],
                []
            )
        );
        expect(rows.map((r) => [r.item.key, r.priority])).toEqual([
            ["agent:late", "urgent"],
            ["agent:fresh", "answer"],
            ["ci:/p:2", "info"],
            ["ready:/p:3", "done"],
        ]);
    });

    it("sorts by date inside a priority, the newest first", () => {
        const rows = notes(list([]), [
            entry("old", { updated: Now - 60 * Min, time: Now - 60 * Min }),
            entry("new", { updated: Now - 1 * Min, time: Now - 1 * Min }),
            entry("mid", { updated: Now - 20 * Min, time: Now - 20 * Min }),
        ]);
        expect(rows.map((r) => r.entry.id)).toEqual(["new", "mid", "old"]);
    });

    it("mixes the rows To handle, the notifications and the agents that finished in one list", () => {
        const rows = notes(
            list([item("agent:a")], [{ key: "done:b9", name: "Benoît", place: "Alpha", line: { key: "x" } }]),
            [entry("n1"), entry("n2", { kind: "success" })]
        );
        expect(rows.map((r) => `${r.source}:${r.priority}`)).toEqual([
            "todo:answer",
            "entry:info",
            "entry:done",
            "finished:done",
        ]);
    });

    it("leaves out a notification that needs an answer: it is a row To handle already", () => {
        const rows = notes(list([]), [entry("w", { kind: "warning" }), entry("i", { kind: "info" })]);
        expect(rows.map((r) => r.entry.id)).toEqual(["i"]);
    });

    it("tells an agent that finished once: by its notification when it raised one, else by its row", () => {
        const info = [
            { key: "done:b1", name: "Olivia", place: "Alpha", workspaceid: "wsA", line: { key: "boss.todo.infoDone" } },
            { key: "done:b2", name: "Jo", place: "Alpha", workspaceid: "wsA", line: { key: "boss.todo.infoDone" } },
        ];
        const told = entry("told", { kind: "success", titlecode: "agentdone", blockid: "b1", source: "agent" });
        const rows = notes(list([], info), [told]);
        expect(rows.map((r) => r.key).sort()).toEqual(["entry:told", "finished:done:b2"]);
        expect(rows.filter((r) => r.source === "finished").map((r) => r.finished.name)).toEqual(["Jo"]);
        // A notification of that agent that tells something else does not hide its row.
        const other = entry("other", { blockid: "b1", source: "agent", title: "Question" });
        expect(notes(list([], info), [other]).filter((r) => r.source === "finished")).toHaveLength(2);
    });

    it("leaves out the archived ones", () => {
        const rows = notes(list([]), [entry("a", { archived: Now }), entry("b")]);
        expect(rows.map((r) => r.entry.id)).toEqual(["b"]);
    });

    it("does not bring the agent's own row back when its archived notification told the finish (#2195)", () => {
        const info = [{ key: "done:b1", name: "Olivia", place: "", since: Now - 5 * Min, line: { key: "x" } }];
        const told = (extra: Partial<MoltentermNotification>) =>
            entry("told", { kind: "success", titlecode: "agentdone", blockid: "b1", source: "agent", ...extra });
        // Archived after the finish: the card is gone and the agent's row does not take its place.
        expect(notes(list([], info), [told({ archived: Now, updated: Now - 5 * Min })])).toEqual([]);
        // An archived one from an earlier finish of the same agent does not tell this one.
        expect(
            notes(list([], info), [told({ archived: Now - 100 * Min, updated: Now - 120 * Min })]).map((r) => r.key)
        ).toEqual(["finished:done:b1"]);
    });

    it("dates an agent that finished by its finish, and sorts it among the Fait rows by it", () => {
        const info = [
            { key: "done:b1", name: "Olivia", place: "", since: Now - 9 * Min, line: { key: "x" } },
            { key: "done:b2", name: "Jo", place: "", since: Now - 3 * Min, line: { key: "x" } },
        ];
        const rows = notes(list([], info));
        expect(rows.map((r) => [r.finished.name, r.since])).toEqual([
            ["Jo", Now - 3 * Min],
            ["Olivia", Now - 9 * Min],
        ]);
    });
});

describe("the card's target and its Go to → (#2195)", () => {
    const place = { workspaceid: "wsA", blockid: "b1", tabid: "t1" };
    const finished = (extra = {}) => ({
        key: "done:b1",
        name: "Olivia",
        place: "",
        blockid: "b1",
        sessionid: "s1",
        line: { key: "x" },
        ...extra,
    });

    it("leads from a notification that comes from somewhere, and from nothing else of its kind", () => {
        const [from, nowhere] = notes(list([]), [entry("from", place), entry("nowhere")]);
        expect(cardTarget(from)).toBe("origin");
        expect(cardGoTo(from)).toBe("origin");
        expect(cardTarget(nowhere)).toBeNull();
        expect(cardGoTo(nowhere)).toBeNull();
    });

    it("leads from an agent that finished that has a place to go, and from none that has not", () => {
        const [row] = notes(list([], [finished()]));
        expect(cardTarget(row)).toBe("agent");
        expect(cardGoTo(row)).toBe("agent");
        const [nowhere] = notes(list([], [finished({ blockid: "", sessionid: "" })]));
        expect(cardTarget(nowhere)).toBeNull();
    });

    it("keeps the card clickable but shows no Go to → when its own action already goes there", () => {
        const own = entry("own", {
            ...place,
            actions: [{ id: "g", label: "Go to Olivia", kind: "open", ...place }],
        });
        const card = entry("card", {
            ...place,
            actions: [{ id: "card", label: "Open", kind: "gesture", gesture: "g" }],
        });
        const [a, b] = notes(list([]), [own, card]);
        for (const row of [a, b]) {
            expect(cardTarget(row)).toBe("origin");
            expect(cardGoTo(row)).toBeNull();
        }
    });

    it("leads from nothing in the archived list, and from no row To handle (their buttons lead)", () => {
        const [row] = notes(list([]), [entry("from", place)]);
        expect(cardTarget(row, true)).toBeNull();
        expect(cardGoTo(row, true)).toBeNull();
        const [todo] = notes(list([item("agent:b1")]));
        expect(cardTarget(todo)).toBeNull();
        expect(cardGoTo(todo)).toBeNull();
    });
});

describe("the source of every kind of card (#2195)", () => {
    it("names it from the notification, and from the key of a row that is none", () => {
        const handoff = item("handoff:r1", { handoff: {} as any });
        const rows = notes(
            list(
                [
                    item("agent:b1"),
                    item("ci:/p:2"),
                    item("ready:/p:3"),
                    handoff,
                    item("notif:n1", { notice: entry("n1", { source: "build" }) }),
                ],
                [{ key: "done:b9", name: "Jo", place: "", line: { key: "x" } }]
            ),
            [entry("e", { source: "release" })]
        );
        const byKey = Object.fromEntries(rows.map((r) => [r.key, rowSourceId(r)]));
        expect(byKey).toEqual({
            "todo:agent:b1": "agent",
            "todo:ci:/p:2": "ci",
            "todo:ready:/p:3": "pr",
            "todo:handoff:r1": "handoff",
            "todo:notif:n1": "build",
            "finished:done:b9": "agent",
            "entry:e": "release",
        });
    });
});

describe("archiving cards (#2195, FR-MC-019 AC15, AC16, AC18)", () => {
    it("clears the notifications, and marks every row that stands for a fact for the episode it shows", () => {
        const rows = notes(
            list(
                [
                    item("agent:b1", { since: Now - 4 * Min, tone: "waiting" }),
                    item("ci:/p:2", { since: Now - 6 * Min, tone: "error" }),
                    item("ready:/p:3", { since: Now - 8 * Min, tone: "success" }),
                ],
                [{ key: "done:b9", name: "Jo", place: "", since: Now - 2 * Min, line: { key: "x" } }]
            ),
            [entry("n1"), entry("n2", { kind: "success" })]
        );
        const plan = archivePlan(rows);
        expect(plan.entryIds.sort()).toEqual(["n1", "n2"]);
        expect(plan.marks).toEqual(
            expect.arrayContaining([
                { key: "agent:b1", since: Now - 4 * Min, tone: "waiting" },
                { key: "ci:/p:2", since: Now - 6 * Min, tone: "error" },
                { key: "ready:/p:3", since: Now - 8 * Min, tone: "success" },
                { key: "done:b9", since: Now - 2 * Min, tone: "done" },
            ])
        );
        expect(plan.marks).toHaveLength(4);
    });

    it("clears the notification a row stands for, and the one an agent's question consumed, and marks no notification row", () => {
        const asking = entry("ask", { kind: "warning", blockid: "b1", source: "agent" });
        const rows = notes(
            list([item("notif:n1", { notice: entry("n1", { kind: "warning" }) }), item("agent:b1", { notice: asking })])
        );
        const plan = archivePlan(rows);
        expect(plan.entryIds.sort()).toEqual(["ask", "n1"]);
        expect(plan.marks.map((m) => m.key)).toEqual(["agent:b1"]);
    });

    it("clears the notification of a hand-off request that no row of its own stands for", () => {
        const request = entry("req", { key: "agenthandoff:r1", kind: "warning" });
        const archived = entry("old", { key: "agenthandoff:r1", archived: Now });
        const rows = notes(list([item("handoff:r1", { handoff: { requestid: "r1" } as any, since: Now })]));
        const plan = archivePlan(rows, [request, archived]);
        expect(plan.entryIds).toEqual(["req"]);
        expect(plan.marks).toEqual([{ key: "handoff:r1", since: Now, tone: "waiting" }]);
    });

    it("plans nothing for no card, and each id once for the same card twice", () => {
        expect(archivePlan([])).toEqual({ entryIds: [], marks: [], rowKeys: [] });
        const [row] = notes(list([]), [entry("n1")]);
        expect(archivePlan([row, row]).entryIds).toEqual(["n1"]);
    });

    it("lowers the counts of the rail and of Brokk's badge once the marks and the archive are in", () => {
        const input = (handled: HandledRows, entries: MoltentermNotification[]) => {
            const toHandle = buildToHandle({
                states: {
                    states: {
                        b1: { blockid: "b1", state: "waiting", since: Now - 4 * Min, version: 1 },
                        b9: { blockid: "b9", state: "done", since: Now - 2 * Min, version: 1 },
                    },
                    versions: {},
                } as any,
                notifications: entries,
                answers: {},
                readied: {},
                sessions: [],
                parked: {},
                handled,
            });
            return { toHandle, rows: notes(toHandle, entries) };
        };
        const before = input({}, [entry("n1")]);
        expect(noteFacts(before.rows).count).toBe(2);
        expect(toHandleBadge(before.toHandle).count).toBe(1);
        expect(before.rows.filter((r) => r.source === "finished")).toHaveLength(1);

        const plan = archivePlan(before.rows);
        const handled = plan.marks.reduce((h, m) => markRowHandled(h, m, Now), {} as HandledRows);
        const after = input(handled, [{ ...entry("n1"), archived: Now }]);
        expect(after.rows).toEqual([]);
        expect(noteFacts(after.rows).count).toBe(0);
        expect(toHandleBadge(after.toHandle).count).toBe(0);

        // The undo: the marks are lifted and the notification is open again.
        const undone = plan.marks.reduce((h, m) => unmarkRowHandled(h, m.key, Now), handled);
        const again = input(undone, [entry("n1")]);
        expect(noteFacts(again.rows).count).toBe(2);
        expect(toHandleBadge(again.toHandle).count).toBe(1);
        expect(again.rows.filter((r) => r.source === "finished")).toHaveLength(1);
    });

    it("names the rows To handle among the cards, for the undo to give them back as no news (#2210)", () => {
        const rows = notes(
            list(
                [item("agent:b1"), item("notif:n1", { notice: entry("n1", { kind: "warning" }) })],
                [{ key: "done:b9", name: "Jo", place: "", since: Now - 2 * Min, line: { key: "x" } }]
            ),
            [entry("n2")]
        );
        expect(archivePlan(rows).rowKeys.sort()).toEqual(["agent:b1", "notif:n1"]);
    });

    it("lists an agent's Done card until it is archived, by its notification or by its own card (#2210)", () => {
        const info = { key: "done:b9", name: "Jo", place: "", since: Now - 2 * Min, line: { key: "x" } };
        const done = entry("d1", {
            titlecode: "agentdone",
            blockid: "b9",
            time: Now - 2 * Min,
            updated: Now - 2 * Min,
        });
        expect([...openDoneBlocks(list([], [info]), [])]).toEqual(["b9"]);
        expect([...openDoneBlocks(list([], [info]), [done])]).toEqual(["b9"]);
        expect([...openDoneBlocks(list([], [info]), [{ ...done, archived: Now }])]).toEqual([]);
        // Its own card archived: the row is marked, so it is no info row any more.
        expect([...openDoneBlocks(list([], []), [])]).toEqual([]);
    });

    it("brings an archived agent back when it finishes again", () => {
        const state = (since: number) =>
            ({ states: { b9: { blockid: "b9", state: "done", since, version: 1 } }, versions: {} }) as any;
        const base = {
            notifications: [],
            answers: {},
            readied: {},
            sessions: [],
            parked: {},
        };
        const first = buildToHandle({ ...base, states: state(Now - 9 * Min) });
        const handled = archivePlan(notes(first)).marks.reduce((h, m) => markRowHandled(h, m, Now), {} as HandledRows);
        expect(buildToHandle({ ...base, states: state(Now - 9 * Min), handled }).info).toEqual([]);
        expect(buildToHandle({ ...base, states: state(Now - 1 * Min), handled }).info).toHaveLength(1);
    });
});

describe("the one primary button", () => {
    it("is only on Urgent and À répondre rows", () => {
        expect(primaryAllowed("urgent")).toBe(true);
        expect(primaryAllowed("answer")).toBe(true);
        expect(primaryAllowed("info")).toBe(false);
        expect(primaryAllowed("done")).toBe(false);
    });

    it("goes to the first action of the row and to no other", () => {
        expect(isPrimaryAction({ priority: "answer" }, 0)).toBe(true);
        expect(isPrimaryAction({ priority: "answer" }, 1)).toBe(false);
        expect(isPrimaryAction({ priority: "urgent" }, 0)).toBe(true);
        expect(isPrimaryAction({ priority: "info" }, 0)).toBe(false);
        expect(isPrimaryAction({ priority: "done" }, 0)).toBe(false);
    });

    it("is never given to a row whose first action is not on offer", () => {
        expect(isPrimaryAction({ priority: "answer" }, 0, false)).toBe(false);
    });

    it("leaves a mixed list with orange buttons on its first rows only", () => {
        const rows = notes(
            list([item("agent:a"), item("ci:/p:1", { tone: "error" }), item("ready:/p:2", { tone: "success" })]),
            [entry("n")]
        );
        expect(rows.filter((r) => primaryAllowed(r.priority)).map((r) => r.priority)).toEqual(["answer"]);
        expect(rows.filter((r) => !primaryAllowed(r.priority))).toHaveLength(3);
    });
});

describe("Info notifications leave once consulted", () => {
    it("marks only the Info notifications as consultable, not the facts or the answers", () => {
        const rows = notes(list([item("agent:a"), item("ci:/p:1", { tone: "error" })]), [
            entry("info"),
            entry("done", { kind: "success" }),
        ]);
        expect(rows.filter((r) => r.consultable).map((r) => r.entry.id)).toEqual(["info"]);
    });

    it("settles the Info notifications the developer saw listed", () => {
        const rows = notes(list([]), [entry("a"), entry("b")]);
        expect(consultedIds(rows, new Set(["a"]))).toEqual(["a"]);
    });

    it("settles nothing when the panel was never shown", () => {
        const rows = notes(list([]), [entry("a"), entry("b")]);
        expect(consultedIds(rows, new Set())).toEqual([]);
    });

    it("never settles a row that stands for a fact, even when it was listed", () => {
        const rows = notes(list([item("ci:/p:1", { tone: "error" })]));
        expect(consultedIds(rows, new Set(["ci:/p:1", "todo:ci:/p:1"]))).toEqual([]);
    });
});

describe("the workspace on each row", () => {
    it("carries the workspace of an agent, a notification and a finished agent, and the folder of a pull request", () => {
        const rows = notes(
            list(
                [item("agent:a", { workspaceid: "wsA" }), item("ci:/proj:5", { tone: "error", dir: "/proj" })],
                [{ key: "done:b", name: "B", place: "Beta", workspaceid: "wsB", line: { key: "x" } }]
            ),
            [entry("n", { workspaceid: "wsC" })]
        );
        const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
        expect(byKey["todo:agent:a"].workspaceid).toBe("wsA");
        expect(byKey["todo:ci:/proj:5"]).toMatchObject({ workspaceid: "", dir: "/proj" });
        expect(byKey["finished:done:b"].workspaceid).toBe("wsB");
        expect(byKey["entry:n"].workspaceid).toBe("wsC");
    });
});

describe("the source beside the workspace", () => {
    it("is left out when it says the workspace's name again, whatever the case or the spaces", () => {
        expect(sourceBesideWorkspace("MoltenTerm", "MoltenTerm")).toBe("");
        expect(sourceBesideWorkspace("moltenterm", " MoltenTerm ")).toBe("");
    });

    it("stays when it says something else, or when there is no workspace name", () => {
        expect(sourceBesideWorkspace("MoltenTerm", "CI")).toBe("CI");
        expect(sourceBesideWorkspace("Alpha", "MoltenTerm")).toBe("MoltenTerm");
        expect(sourceBesideWorkspace("", "MoltenTerm")).toBe("MoltenTerm");
        expect(sourceBesideWorkspace(undefined, "build")).toBe("build");
    });

    it("has nothing to show for no source", () => {
        expect(sourceBesideWorkspace("Alpha", "")).toBe("");
    });
});

describe("what the list tells the rail", () => {
    it("counts what asks for something, not the agents that finished, and is red for Urgent and À répondre", () => {
        const rows = notes(list([item("agent:a"), item("ready:/p:2", { tone: "success" })]), [entry("n")]);
        expect(noteFacts(rows)).toEqual({ count: 2, urgentOrAnswer: true, unread: true });
    });

    it("is quiet with nothing listed", () => {
        expect(noteFacts([])).toEqual({ count: 0, urgentOrAnswer: false, unread: false });
    });

    it("calls a pull request ready to merge unread: Fait, and still news (#2085)", () => {
        const rows = notes(list([item("ready:/p:2080", { tone: "success" })]), []);
        expect(noteFacts(rows)).toEqual({ count: 0, urgentOrAnswer: false, unread: true });
    });

    it("does not call a read Info notification unread", () => {
        const rows = notes(list([]), [entry("a", { read: true })]);
        expect(noteFacts(rows)).toEqual({ count: 1, urgentOrAnswer: false, unread: false });
    });
});
