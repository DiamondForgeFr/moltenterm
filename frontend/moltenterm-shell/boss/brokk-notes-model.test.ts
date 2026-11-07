// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { MoltentermNotification } from "../notifications-model";
import { ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import {
    buildNotes,
    consultedIds,
    entrySeverity,
    isPrimaryAction,
    noteFacts,
    NoteRow,
    primaryAllowed,
    priorityOf,
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

    it("does not call a read Info notification unread", () => {
        const rows = notes(list([]), [entry("a", { read: true })]);
        expect(noteFacts(rows)).toEqual({ count: 1, urgentOrAnswer: false, unread: false });
    });
});
