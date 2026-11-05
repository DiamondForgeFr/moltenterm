// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AgentStateInfo, AgentStatesData, applyAgentStates, EmptyAgentStates } from "../agent-state-model";
import { UsageSnapshot } from "../companion/companion-gauges-model";
import { MoltentermNotification } from "../notifications-model";
import { DurableSession } from "../sessions/sessions-model";
import {
    attentionAgents,
    badgeTone,
    bubbleLabel,
    latestNotification,
    makeBadge,
    makePeek,
    PeekInput,
    peekIsQuiet,
    PeekNamesLimit,
    PeekWaitingLimit,
    PeekWorkplaceLimit,
    usageLine,
    workplaceNames,
    workspaceNamesOf,
} from "./boss-overview";

const Now = 1_700_000_000_000;

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

function states(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((i) => [i.blockid, i])), versions: {} };
}

function session(blockid: string, workspaceid: string, workspacename: string, order = 0): DurableSession {
    return {
        id: `s-${blockid}`,
        shortid: blockid,
        connection: "",
        connstate: "connected",
        workspaceid,
        workspacename,
        workspaceorder: order,
        blockid,
        shown: true,
        canshow: true,
        canend: true,
    };
}

function note(id: string, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return { id, source: "agent", title: `Title ${id}`, kind: "info", time: 1, updated: 1, read: false, ...extra };
}

function input(partial: Partial<PeekInput> = {}): PeekInput {
    return { states: states(), sessions: [], notifications: [], usage: {}, now: Now, ...partial };
}

describe("the agents that need the developer (FR-BOSS-001, AC5)", () => {
    it("are the ones waiting or failed, in every workspace", () => {
        const list = attentionAgents(
            states(
                agent("a", "waiting", { workspaceid: "w1" }),
                agent("b", "error", { workspaceid: "w2" }),
                agent("c", "working"),
                agent("d", "done"),
                agent("e", "idle")
            )
        );
        expect(list.map((i) => i.blockid)).toEqual(["b", "a"]);
    });

    it("come failed first, then waiting, the oldest first", () => {
        const list = attentionAgents(
            states(
                agent("w-new", "waiting", { since: 300 }),
                agent("w-old", "waiting", { since: 100 }),
                agent("e-new", "error", { since: 400 }),
                agent("e-old", "error", { since: 200 })
            )
        );
        expect(list.map((i) => i.blockid)).toEqual(["e-old", "e-new", "w-old", "w-new"]);
    });

    it("count nobody when nothing is known", () => {
        expect(attentionAgents(null)).toEqual([]);
        expect(attentionAgents(states())).toEqual([]);
        expect(makeBadge([]).count).toBe(0);
        expect(makeBadge([]).text).toBe("");
    });

    it("show a badge red when one failed, amber otherwise, 9+ beyond nine", () => {
        expect(badgeTone([agent("a", "waiting")])).toBe("waiting");
        expect(badgeTone([agent("a", "waiting"), agent("b", "error")])).toBe("error");
        const nine = Array.from({ length: 9 }, (_, i) => agent(`n${i}`, "waiting"));
        expect(makeBadge(nine).text).toBe("9");
        expect(makeBadge([...nine, agent("x", "waiting")]).text).toBe("9+");
        expect(makeBadge([...nine, agent("x", "waiting")]).count).toBe(10);
    });

    it("drop an agent whose session ended, and never count it again from an older event (#1920)", () => {
        const waiting = agent("a", "waiting", { version: 4 });
        let data = applyAgentStates(EmptyAgentStates, [waiting, agent("b", "working", { version: 5 })]);
        expect(makeBadge(attentionAgents(data)).count).toBe(1);
        data = applyAgentStates(data, [{ blockid: "a", version: 6, cleared: true } as AgentStateInfo]);
        expect(makeBadge(attentionAgents(data)).count).toBe(0);
        data = applyAgentStates(data, [waiting]);
        expect(makeBadge(attentionAgents(data)).count).toBe(0);
    });

    it("name the button with the name and the count (AC10)", () => {
        expect(bubbleLabel("Ferrand", 2)).toBe("Ferrand, 2 waiting");
        expect(bubbleLabel("Léa", 0)).toBe("Léa, 0 waiting");
    });
});

describe("the peek (AC7)", () => {
    it("lists what waits with the agent's first name, its workspace and its state", () => {
        const peek = makePeek(
            input({
                states: states(
                    agent("a", "waiting", { firstname: "Léa", workspaceid: "w1" }),
                    agent("b", "error", { firstname: "", agentname: "Codex", workspaceid: "w2" })
                ),
                sessions: [session("a", "w1", "Alpha"), session("b", "w2", "Beta", 1)],
            })
        );
        expect(peek.waiting).toEqual([
            { id: "b", name: "Codex", workspace: "Beta", state: "error" },
            { id: "a", name: "Léa", workspace: "Alpha", state: "waiting" },
        ]);
        expect(peek.waitingMore).toBe(0);
    });

    it("shows up to three rows, then says how many more", () => {
        const many = Array.from({ length: PeekWaitingLimit + 4 }, (_, i) => agent(`m${i}`, "waiting", { since: i }));
        const peek = makePeek(input({ states: states(...many) }));
        expect(peek.waiting).toHaveLength(PeekWaitingLimit);
        expect(peek.waitingMore).toBe(4);
    });

    it("finds the workspace of an agent through its session, else through the workspace's other sessions", () => {
        const peek = makePeek(
            input({
                states: states(
                    agent("direct", "waiting", { workspaceid: "w1" }),
                    agent("other", "waiting", { workspaceid: "w2", since: 200 }),
                    agent("unknown", "waiting", { workspaceid: "w9", since: 300 })
                ),
                sessions: [session("direct", "w1", "Alpha"), session("elsewhere", "w2", "Beta")],
            })
        );
        expect(Object.fromEntries(peek.waiting.map((r) => [r.id, r.workspace]))).toEqual({
            direct: "Alpha",
            other: "Beta",
            unknown: "",
        });
    });

    it("prefers the workspace objects' names, and reads only the workspaces of the agents it lists", () => {
        const asked: string[] = [];
        const names = workspaceNamesOf(
            states(
                agent("a", "waiting", { workspaceid: "w1" }),
                agent("b", "working", { workspaceid: "w2" }),
                agent("c", "done", { workspaceid: "w3" }),
                agent("d", "waiting", { workspaceid: "w1" })
            ),
            (id) => {
                asked.push(id);
                return { name: `Name ${id}` };
            }
        );
        expect(names).toEqual({ w1: "Name w1", w2: "Name w2" });
        expect(asked).toEqual(["w1", "w2"]);
        const peek = makePeek(
            input({
                states: states(agent("a", "waiting", { workspaceid: "w1" })),
                workspaceNames: { w1: "From the object" },
                sessions: [session("a", "w1", "From the session")],
            })
        );
        expect(peek.waiting[0].workspace).toBe("From the object");
    });

    it("shows a starter workspace by its translated name", () => {
        const peek = makePeek(
            input({
                states: states(agent("a", "waiting")),
                sessions: [session("a", "w1", "Starter workspace")],
            })
        );
        expect(peek.waiting[0].workspace).toBe("Starter workspace");
    });

    it("says who works in which workspace, in the rail's order", () => {
        const peek = makePeek(
            input({
                states: states(
                    agent("a", "working", { firstname: "Léa", workspaceid: "w2", since: 1 }),
                    agent("b", "working", { firstname: "Max", workspaceid: "w1", since: 2 }),
                    agent("c", "working", { firstname: "Zoé", workspaceid: "w2", since: 3 }),
                    agent("d", "waiting", { firstname: "Not working", workspaceid: "w1" })
                ),
                sessions: [session("b", "w1", "Alpha", 0), session("a", "w2", "Beta", 1)],
            })
        );
        expect(peek.working).toEqual([
            { workspace: "Alpha", names: ["Max"], more: 0 },
            { workspace: "Beta", names: ["Léa", "Zoé"], more: 0 },
        ]);
        expect(workplaceNames(peek.working[1])).toBe("Léa, Zoé");
    });

    it("caps the names of a workspace and the workspaces listed", () => {
        const names = Array.from({ length: PeekNamesLimit + 2 }, (_, i) =>
            agent(`n${i}`, "working", { firstname: `N${i}`, since: i })
        );
        const places = Array.from({ length: PeekWorkplaceLimit + 2 }, (_, i) =>
            agent(`p${i}`, "working", { firstname: `P${i}`, workspaceid: `wp${i}`, since: 1000 + i })
        );
        const peek = makePeek(input({ states: states(...names, ...places) }));
        expect(peek.working.length).toBe(PeekWorkplaceLimit);
        expect(peek.workingMore).toBe(3);
        const crowded = peek.working.find((p) => p.names.length === PeekNamesLimit);
        expect(crowded.more).toBe(2);
        expect(workplaceNames(crowded)).toBe("N0, N1, N2 and 2 more");
    });

    it("is quiet when nobody waits or works", () => {
        expect(peekIsQuiet(makePeek(input()))).toBe(true);
        expect(peekIsQuiet(makePeek(input({ states: states(agent("a", "done"), agent("b", "idle")) })))).toBe(true);
        expect(peekIsQuiet(makePeek(input({ states: states(agent("a", "working")) })))).toBe(false);
    });
});

describe("the latest notification (AC7)", () => {
    it("is the one changed last, archived ones left out", () => {
        const latest = latestNotification([
            note("old", { updated: 10 }),
            note("new", { updated: 30 }),
            note("archived", { updated: 99, archived: 100 }),
            note("mid", { updated: 20 }),
        ]);
        expect(latest.id).toBe("new");
        expect(latest.title).toBe("Title new");
    });

    it("uses the message wavesrv wrote, or the agent's", () => {
        expect(latestNotification([note("a", { message: "It stopped." })]).message).toBe("It stopped.");
        expect(latestNotification([note("a")]).message).toBe("");
    });

    it("is nothing without notifications", () => {
        expect(latestNotification([])).toBeNull();
        expect(latestNotification(null)).toBeNull();
        expect(latestNotification([note("a", { archived: 5 })])).toBeNull();
        expect(makePeek(input()).latest).toBeNull();
    });
});

describe("the plan usage line (AC7, FR-SHELL-027)", () => {
    function reading(agent: string, windows: { id: string; label: string; usedpercent: number }[]): UsageSnapshot {
        return { agent, source: "test", windows, readat: Now };
    }

    it("shows the fullest plan window of the readings that exist", () => {
        const line = usageLine(
            {
                claude: reading("claude", [
                    { id: "5h", label: "5-hour", usedpercent: 23.5 },
                    { id: "7d", label: "Week", usedpercent: 61 },
                ]),
                codex: reading("codex", [{ id: "5h", label: "5-hour", usedpercent: 40 }]),
            },
            new Map([["claude", "Claude Code"]]),
            Now
        );
        expect(line).toBe("Claude Code: Week, 61 % used");
    });

    it("names the agent by its id when its state is not known", () => {
        const line = usageLine(
            { codex: reading("codex", [{ id: "w", label: "Week", usedpercent: 5 }]) },
            new Map(),
            Now
        );
        expect(line).toBe("codex: Week, 5 % used");
    });

    it("is no line without a reading", () => {
        expect(usageLine({}, new Map(), Now)).toBe("");
        expect(usageLine(null, new Map(), Now)).toBe("");
        expect(usageLine({ claude: reading("claude", []) }, new Map(), Now)).toBe("");
        expect(makePeek(input()).usage).toBe("");
    });

    it("rides on the peek with the agents' names from their states", () => {
        const peek = makePeek(
            input({
                states: states(agent("a", "working")),
                usage: { claude: reading("claude", [{ id: "5h", label: "5-hour", usedpercent: 80 }]) },
            })
        );
        expect(peek.usage).toBe("Claude Code: 5-hour, 80 % used");
    });
});
