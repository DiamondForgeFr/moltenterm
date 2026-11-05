// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
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
