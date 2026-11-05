// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { PendingHandoff } from "../agent-handoff-types";
import { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { MoltentermNotification } from "../notifications-model";
import { ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import { DurableSession } from "../sessions/sessions-model";
import { buildToHandle, toHandleBadge, ToHandleInput } from "./boss-to-handle-model";

function agent(blockid: string, state: AgentStateInfo["state"], extra: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return {
        blockid,
        workspaceid: "w1",
        agent: "claude",
        agentname: "Claude Code",
        firstname: `Agent ${blockid}`,
        state,
        since: 100,
        version: 1,
        ...extra,
    };
}

function states(...list: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(list.map((info) => [info.blockid, info])) } as AgentStatesData;
}

function session(blockid: string, id: string): DurableSession {
    return { id, blockid, workspacename: "Forge" } as DurableSession;
}

function notice(id: string, blockid: string, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id,
        time: 200,
        updated: 200,
        source: "agent",
        title: "Question",
        kind: "warning",
        read: false,
        blockid,
        ...extra,
    } as MoltentermNotification;
}

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://example.test/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "2026-11-01T10:00:00Z",
        updatedat: "2026-11-01T10:00:00Z",
        draft: false,
        merge: "clean",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
        ...extra,
    } as ReviewPr;
}

function answers(dir: string, ...list: ReviewPr[]): Record<string, ReviewsAnswer> {
    return { [dir]: { dir, state: "ok", ready: list, drafts: [] } as ReviewsAnswer };
}

function input(extra: Partial<ToHandleInput> = {}): ToHandleInput {
    return {
        states: states(),
        notifications: [],
        answers: {},
        readied: {},
        sessions: [],
        parked: {},
        ...extra,
    };
}

describe("buildToHandle: agents", () => {
    it("lists every agent that waits or stopped, the failed first, then the oldest wait", () => {
        const list = buildToHandle(
            input({
                states: states(
                    agent("b1", "waiting", { since: 300 }),
                    agent("b2", "error", { since: 500 }),
                    agent("b3", "waiting", { since: 200 }),
                    agent("b4", "working")
                ),
                sessions: [session("b1", "s1"), session("b2", "s2"), session("b3", "s3")],
            })
        );
        expect(list.items.map((item) => item.key)).toEqual(["agent:b2", "agent:b3", "agent:b1"]);
        expect(list.items[0].tone).toBe("error");
        expect(list.items[1].tone).toBe("waiting");
    });

    it("leads each agent row to its pane, and disables Go to when no session shows it", () => {
        const list = buildToHandle(
            input({ states: states(agent("b1", "waiting"), agent("b2", "waiting")), sessions: [session("b1", "s1")] })
        );
        const byKey = Object.fromEntries(list.items.map((item) => [item.key, item]));
        const goOf = (key: string) => byKey[key].actions.find((a) => a.id === "goto");
        expect(goOf("agent:b1").run).toEqual({ kind: "goto", sessionId: "s1" });
        expect(goOf("agent:b1").disabled).toBe(false);
        expect(goOf("agent:b2").disabled).toBe(true);
    });

    it("gives the row the question its notification asks, answered by the notification's own buttons", () => {
        const question = notice("n1", "b1", {
            actions: [
                { id: "yes", label: "Yes", kind: "gesture", gesture: "answer" },
                { id: "no", label: "No", kind: "gesture", gesture: "answer" },
            ],
        });
        const list = buildToHandle(
            input({
                states: states(agent("b1", "waiting")),
                sessions: [session("b1", "s1")],
                notifications: [question],
            })
        );
        expect(list.items.map((item) => item.key)).toEqual(["agent:b1"]);
        const row = list.items[0];
        expect(row.lineFromNotice).toBe(true);
        expect(row.actions.map((a) => a.id)).toEqual(["answer:yes", "answer:no", "goto", "later"]);
        expect(row.actions[0].primary).toBe(true);
        expect(row.actions[0].run).toEqual({ kind: "answer", entry: question, action: question.actions[0] });
    });
});

describe("buildToHandle: notifications", () => {
    it("lists a notification that needs an answer, with its buttons first", () => {
        const permission = notice("n2", "", {
            source: "trust",
            blockid: undefined,
            actions: [{ id: "allow", label: "Allow", kind: "gesture", gesture: "allow" }],
        });
        const list = buildToHandle(input({ notifications: [permission] }));
        expect(list.items.map((item) => item.key)).toEqual(["notif:n2"]);
        expect(list.items[0].actions[0].id).toBe("answer:allow");
        expect(list.items[0].actions[0].primary).toBe(true);
    });

    it("offers Open as the primary action of a notification with no button", () => {
        const warning = notice("n3", "", { blockid: undefined, source: "moltenterm" });
        const list = buildToHandle(input({ notifications: [warning] }));
        expect(list.items[0].actions.map((a) => a.id)).toEqual(["open", "later"]);
        expect(list.items[0].actions[0].primary).toBe(true);
    });

    it("leaves out the notifications that tell and ask nothing", () => {
        const info = notice("n4", "", { kind: "info", blockid: undefined });
        const resolved = notice("n5", "", { resolved: 1, blockid: undefined });
        const list = buildToHandle(input({ notifications: [info, resolved] }));
        expect(list.items).toEqual([]);
    });
});

describe("buildToHandle: pull requests", () => {
    it("lists a failing CI with See the failure first and Rerun the CI beside it", () => {
        const failing = pr(1925, {
            ci: {
                state: "failure",
                success: 0,
                failure: 1,
                pending: 0,
                checks: [{ name: "Frontend", state: "failure" }] as ReviewPr["ci"]["checks"],
            },
        });
        const list = buildToHandle(input({ answers: answers("/work/moltenterm", failing) }));
        expect(list.items.map((item) => item.key)).toEqual(["ci:/work/moltenterm:1925"]);
        const row = list.items[0];
        expect(row.tone).toBe("error");
        expect(row.place).toBe("moltenterm");
        expect(row.actions.map((a) => a.labelKey)).toEqual([
            "boss.todo.seeFailure",
            "boss.todo.rerunCi",
            "boss.todo.later",
        ]);
        expect(row.actions[0].run).toEqual({ kind: "integration", dir: "/work/moltenterm", number: 1925 });
        expect(row.actions[1].run).toEqual({ kind: "rerun", dir: "/work/moltenterm", number: 1925 });
    });

    it("lists a PR ready to merge, opened in Integration first", () => {
        const ready = pr(1928);
        const list = buildToHandle(input({ answers: answers("/work/moltenterm", ready) }));
        expect(list.items.map((item) => item.key)).toEqual(["ready:/work/moltenterm:1928"]);
        const row = list.items[0];
        expect(row.tone).toBe("success");
        expect(row.actions[0].labelKey).toBe("boss.todo.openIntegration");
        expect(row.actions[1].run).toEqual({ kind: "external", url: ready.url });
    });

    it("leaves out a PR that is not mergeable yet, a draft, or an answer GitHub did not give", () => {
        const pending = pr(1, { ci: { state: "pending", success: 0, failure: 0, pending: 1, checks: [] } });
        const conflicting = pr(2, { merge: "conflicts" });
        const broken: Record<string, ReviewsAnswer> = {
            "/work/x": { dir: "/work/x", state: "error", ready: [pr(3)], drafts: [] } as ReviewsAnswer,
        };
        const list = buildToHandle(
            input({ answers: { ...answers("/work/moltenterm", pending, conflicting), ...broken } })
        );
        expect(list.items).toEqual([]);
    });
});

describe("buildToHandle: info and Later", () => {
    it("keeps finished agents apart as info rows with no action", () => {
        const list = buildToHandle(input({ states: states(agent("b9", "done")), sessions: [session("b9", "s9")] }));
        expect(list.items).toEqual([]);
        expect(list.info.map((row) => row.key)).toEqual(["done:b9"]);
    });

    it("sets aside the rows parked with Later, and counts them", () => {
        const list = buildToHandle(
            input({
                states: states(agent("b1", "waiting"), agent("b2", "waiting")),
                parked: { "agent:b1": true },
            })
        );
        expect(list.items.map((item) => item.key)).toEqual(["agent:b2"]);
        expect(list.parked).toBe(1);
    });
});

describe("toHandleBadge", () => {
    it("counts the rows to handle, never the info rows or the rows set aside", () => {
        const list = buildToHandle(
            input({
                states: states(agent("b1", "waiting"), agent("b2", "done"), agent("b3", "waiting")),
                parked: { "agent:b3": true },
            })
        );
        const badge = toHandleBadge(list);
        expect(badge.count).toBe(1);
        expect(badge.tone).toBe("waiting");
    });

    it("turns red when one row is an error, and counts nothing for nobody", () => {
        const failing = pr(7, {
            ci: { state: "failure", success: 0, failure: 1, pending: 0, checks: [] },
        });
        const list = buildToHandle(input({ states: states(agent("b1", "waiting")), answers: answers("/w", failing) }));
        expect(toHandleBadge(list)).toMatchObject({ count: 2, tone: "error" });
        expect(toHandleBadge(buildToHandle(input()))).toMatchObject({ count: 0 });
    });
});

function request(requestid: string, extra: Partial<PendingHandoff> = {}): PendingHandoff {
    return {
        requestid,
        fromblockid: "bs",
        toblockid: "br",
        from: "Chloé",
        to: "Léa",
        goal: "Propose characters for MoltenTerm",
        createdat: 1000,
        fromworkspace: "DiamondForge",
        toworkspace: "MoltenTerm",
        brief: {
            goal: "Propose characters for MoltenTerm,\nin the style of Geargrim",
            context: "See the notes",
            files: [
                { path: "/work/df/characters.md" },
                { path: "/work/df/geargrim/README.md", lines: "4-9", note: "the style" },
            ],
            links: [{ url: "https://example.test/ticket/7", title: "Ticket 7", kind: "ticket" }],
            reply: true,
        },
        ...extra,
    };
}

function handoffNotice(requestid: string, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return notice(`notif-${requestid}`, "bs", {
        key: `agenthandoff:${requestid}`,
        source: "agents" as MoltentermNotification["source"],
        actions: [
            { id: "once", label: "Allow once", kind: "gesture", gesture: "molten:agenthandoff" },
            { id: "always", label: "Always for this pair", kind: "gesture", gesture: "molten:agenthandoff" },
            { id: "block", label: "Block", kind: "gesture", gesture: "molten:agenthandoff" },
        ],
        ...extra,
    });
}

describe("buildToHandle: hand-off requests (FR-BOSS-005)", () => {
    it("lists one row per pending request, oldest first, with who asks whom and from where", () => {
        const list = buildToHandle(
            input({ handoffs: [request("r2", { createdat: 3000 }), request("r1", { createdat: 1000 })] })
        );
        expect(list.items.map((item) => item.key)).toEqual(["handoff:r1", "handoff:r2"]);
        const row = list.items[0];
        expect(row.tone).toBe("waiting");
        expect(row.since).toBe(1000);
        expect(row.handoff).toMatchObject({
            requestid: "r1",
            from: "Chloé",
            to: "Léa",
            fromPlace: "DiamondForge",
            toPlace: "MoltenTerm",
            goal: "Propose characters for MoltenTerm",
        });
    });

    it("names what is attached and keeps the whole brief for Read the brief", () => {
        const row = buildToHandle(input({ handoffs: [request("r1")] })).items[0];
        expect(row.handoff.files).toEqual([
            { name: "characters.md", detail: "/work/df/characters.md" },
            { name: "README.md", detail: "/work/df/geargrim/README.md:4-9" },
        ]);
        expect(row.handoff.links).toEqual([{ name: "Ticket 7", detail: "https://example.test/ticket/7" }]);
        expect(row.handoff.brief).toMatchObject({ context: "See the notes", reply: true });
        expect(row.handoff.brief.goal).toContain("in the style of Geargrim");
    });

    it("offers Allow once first, then Always for this pair, Refuse and Read the brief", () => {
        const row = buildToHandle(input({ handoffs: [request("r1")] })).items[0];
        expect(row.actions.map((a) => [a.id, a.labelKey, a.primary])).toEqual([
            ["once", "boss.todo.handoff.once", true],
            ["always", "boss.todo.handoff.always", false],
            ["refuse", "boss.todo.handoff.refuse", false],
            ["brief", "boss.todo.handoff.brief", false],
        ]);
        expect(row.actions.slice(0, 3).map((a) => a.run)).toEqual([
            { kind: "handoff", requestid: "r1", decision: "once" },
            { kind: "handoff", requestid: "r1", decision: "always" },
            { kind: "handoff", requestid: "r1", decision: "block" },
        ]);
        expect(row.actions[3].run).toEqual({ kind: "brief" });
        expect(row.actions.some((a) => a.run.kind === "later")).toBe(false);
    });

    it("counts in the badge, as a wait, with the other rows", () => {
        const list = buildToHandle(
            input({ handoffs: [request("r1"), request("r2")], states: states(agent("b1", "waiting")) })
        );
        expect(toHandleBadge(list)).toMatchObject({ count: 3, tone: "waiting" });
        expect(toHandleBadge(buildToHandle(input({ handoffs: [] })))).toMatchObject({ count: 0 });
    });

    it("stands for the request's notification: one request is one row, not two", () => {
        const list = buildToHandle(
            input({ handoffs: [request("r1")], notifications: [handoffNotice("r1"), handoffNotice("r2")] })
        );
        // r2 has no pending request in the list yet: its notification keeps its own row and buttons.
        expect(list.items.map((item) => item.key).sort()).toEqual(["handoff:r1", "notif:notif-r2"]);
    });

    it("never takes the request's notification for its sender's question", () => {
        const list = buildToHandle(
            input({
                handoffs: [request("r1")],
                notifications: [handoffNotice("r1")],
                states: states(agent("bs", "waiting")),
                sessions: [session("bs", "s1")],
            })
        );
        const agentRow = list.items.find((item) => item.key === "agent:bs");
        expect(agentRow.notice).toBeNull();
        expect(agentRow.actions.map((a) => a.id)).toEqual(["goto", "later"]);
        expect(list.items.some((item) => item.key.startsWith("notif:"))).toBe(false);
    });

    it("keeps the row when its notification was archived or filtered out", () => {
        const list = buildToHandle(input({ handoffs: [request("r1")], notifications: [] }));
        expect(list.items.map((item) => item.key)).toEqual(["handoff:r1"]);
    });

    it("leaves the list once the request is answered, wherever it was answered", () => {
        const waiting = buildToHandle(input({ handoffs: [request("r1")], notifications: [handoffNotice("r1")] }));
        expect(waiting.items).toHaveLength(1);
        const answered = buildToHandle(input({ handoffs: [], notifications: [handoffNotice("r1", { resolved: 5 })] }));
        expect(answered.items).toEqual([]);
    });

    it("names an unnamed terminal with an empty name, and a workspace with its project when it has none", () => {
        const row = buildToHandle(
            input({
                handoffs: [request("r1", { from: "", fromworkspace: "", fromproject: "forge", toworkspace: "" })],
            })
        ).items[0];
        expect(row.handoff).toMatchObject({ from: "", fromPlace: "forge", toPlace: "" });
    });

    it("reads a request without a brief by its goal", () => {
        const row = buildToHandle(input({ handoffs: [request("r1", { brief: undefined })] })).items[0];
        expect(row.handoff.brief).toEqual({ goal: "Propose characters for MoltenTerm" });
        expect(row.handoff.files).toEqual([]);
        expect(row.handoff.links).toEqual([]);
    });
});
