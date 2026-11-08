// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AgentStateInfo, AgentStatesData, applyAgentStates, EmptyAgentStates } from "../agent-state-model";
import { UsageSnapshot, usageWindowLabel } from "../companion/companion-gauges-model";
import { I18nModel } from "../i18n/i18n";
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
    PeekNamesLimit,
    PeekWaitingLimit,
    PeekWaitingRow,
    PeekWorkplaceLimit,
    usageLine,
    workingCount,
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
    return { states: states(), toHandle: [], sessions: [], notifications: [], usage: {}, now: Now, ...partial };
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
        expect(bubbleLabel("Brokk", 2)).toBe("Brokk, 2 waiting");
        expect(bubbleLabel("Léa", 0)).toBe("Léa, 0 waiting");
    });
});

describe("the agents at work (FR-BOSS-007, AC2)", () => {
    it("counts the agents that work, in every workspace, and none of the other states", () => {
        const data = states(
            agent("a", "working"),
            agent("b", "working", { workspaceid: "w2" }),
            agent("c", "waiting"),
            agent("d", "error"),
            agent("e", "done"),
            agent("f", "idle")
        );
        expect(workingCount(data)).toBe(2);
    });

    it("counts none before the first reading", () => {
        expect(workingCount(EmptyAgentStates)).toBe(0);
        expect(workingCount(null)).toBe(0);
    });
});

describe("the peek (AC7)", () => {
    function row(id: string, extra: Partial<PeekWaitingRow> = {}): PeekWaitingRow {
        return { id, name: id, workspace: "", tone: "waiting", line: "", ...extra };
    }

    it("lists the rows the badge counts, whatever they are: an agent, a failing CI, a hand-off request (#1959)", () => {
        const rows: PeekWaitingRow[] = [
            row("agent:b", { name: "Codex", workspace: "Beta", tone: "error", line: "error" }),
            row("ci:/p:12", { name: "#12", workspace: "p", tone: "error", line: "CI failing: build" }),
            row("handoff:r1", { name: "Chloé", line: "Fix the login" }),
        ];
        const peek = makePeek(input({ toHandle: rows }));
        expect(peek.waiting).toEqual(rows);
        expect(peek.waitingMore).toBe(0);
    });

    it("lists as many rows as the badge counts: what the badge says, the hover card says (#1959)", () => {
        for (const count of [0, 1, 3, 5, 12]) {
            const rows = Array.from({ length: count }, (_, i) => row(`handoff:r${i}`));
            const peek = makePeek(input({ toHandle: rows }));
            expect(peek.waiting.length + peek.waitingMore).toBe(count);
        }
    });

    it("shows up to three rows, then says how many more", () => {
        const many = Array.from({ length: PeekWaitingLimit + 4 }, (_, i) => row(`agent:m${i}`));
        const peek = makePeek(input({ toHandle: many }));
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
                toHandle: [row("agent:direct"), row("agent:other"), row("agent:unknown")],
                sessions: [session("direct", "w1", "Alpha"), session("elsewhere", "w2", "Beta")],
            })
        );
        expect(Object.fromEntries(peek.waiting.map((r) => [r.id, r.workspace]))).toEqual({
            "agent:direct": "Alpha",
            "agent:other": "Beta",
            "agent:unknown": "",
        });
    });

    it("keeps the place a row already has", () => {
        const peek = makePeek(
            input({
                states: states(agent("a", "waiting", { workspaceid: "w1" })),
                toHandle: [row("agent:a", { workspace: "Its own" })],
                sessions: [session("a", "w1", "Alpha")],
            })
        );
        expect(peek.waiting[0].workspace).toBe("Its own");
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
                toHandle: [row("agent:a")],
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
                toHandle: [row("agent:a")],
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

describe("the plan usage lines (AC7, FR-SHELL-027)", () => {
    const MinMs = 60_000;
    const HourMs = 60 * MinMs;

    function reading(
        agent: string,
        windows: { id: string; label: string; usedpercent: number; resetsat?: number }[],
        readat = Now
    ): UsageSnapshot {
        return { agent, source: "test", windows, readat };
    }

    it("shows one line per provider, the fullest first, each at its fullest window", () => {
        const lines = usageLine(
            {
                claude: reading("claude", [
                    { id: "5h", label: "Current session", usedpercent: 23.5 },
                    { id: "7d", label: "This week", usedpercent: 61 },
                ]),
                codex: reading("codex", [{ id: "5h", label: "5-hour", usedpercent: 70 }]),
            },
            new Map([["claude", "Claude Code"]]),
            Now
        );
        expect(lines.map((l) => [l.agent, l.label, l.percent])).toEqual([
            ["codex", "5-hour", "70 % used"],
            ["Claude Code", "This week", "61 % used"],
        ]);
    });

    it("shows a provider once, from its latest reading, when several agents share its plan", () => {
        const lines = usageLine(
            {
                a1: reading("claude", [{ id: "7d", label: "This week", usedpercent: 20 }], Now - 1000),
                a2: reading("claude", [{ id: "7d", label: "This week", usedpercent: 70 }], Now),
            },
            new Map([["claude", "Claude Code"]]),
            Now
        );
        expect(lines.map((l) => [l.agent, l.percent])).toEqual([["Claude Code", "70 % used"]]);
    });

    it("names the agent by its id when its state is not known", () => {
        const lines = usageLine(
            { codex: reading("codex", [{ id: "w", label: "This week", usedpercent: 5 }]) },
            new Map(),
            Now
        );
        expect(lines.map((l) => l.agent)).toEqual(["codex"]);
    });

    it("is no line without a reading", () => {
        expect(usageLine({}, new Map(), Now)).toEqual([]);
        expect(usageLine(null, new Map(), Now)).toEqual([]);
        expect(usageLine({ claude: reading("claude", []) }, new Map(), Now)).toEqual([]);
        expect(makePeek(input()).usage).toEqual([]);
    });

    it("translates the window labels the readers send", () => {
        const I18n = I18nModel.getInstance();
        I18n.setLanguageSetting("fr");
        try {
            const labels = [
                "Current session",
                "This week",
                "This week (Opus)",
                "Spend limit",
                "5-hour",
                "3-day",
                "2-hour",
                "15-min",
                "GPT-5 5-hour",
            ].map((label) => usageWindowLabel(label));
            expect(labels).toEqual([
                "Session en cours",
                "Cette semaine",
                "Cette semaine (Opus)",
                "Limite de dépenses",
                "5 h",
                "3 j",
                "2 h",
                "15 min",
                "GPT-5 5 h",
            ]);
            const lines = usageLine(
                { codex: reading("codex", [{ id: "5h", label: "5-hour", usedpercent: 3 }]) },
                new Map([["codex", "Codex"]]),
                Now
            );
            expect(lines.map((l) => [l.agent, l.label])).toEqual([["Codex", "5 h"]]);
        } finally {
            I18n.setLanguageSetting("en");
        }
    });

    it("marks a provider at or above 80 % in the warning colour, and at 95 % as an error", () => {
        const lines = usageLine(
            {
                claude: reading("claude", [{ id: "7d", label: "This week", usedpercent: 85 }]),
                codex: reading("codex", [{ id: "5h", label: "5-hour", usedpercent: 96 }]),
                gemini: reading("gemini", [{ id: "5h", label: "5-hour", usedpercent: 12 }]),
            },
            new Map([["claude", "Claude Code"]]),
            Now
        );
        expect(lines.map((l) => [l.agent, l.level])).toEqual([
            ["codex", "error"],
            ["Claude Code", "warning"],
            ["gemini", "normal"],
        ]);
    });

    it("gives the reset of the fullest window when the reading has one", () => {
        const lines = usageLine(
            {
                codex: reading("codex", [
                    { id: "5h", label: "5-hour", usedpercent: 3, resetsat: Now + 2 * HourMs + 14 * MinMs },
                    { id: "7d", label: "This week", usedpercent: 1 },
                ]),
            },
            new Map(),
            Now
        );
        expect(lines.map((l) => [l.label, l.resets])).toEqual([["5-hour", "in 2 h 14 min"]]);
    });

    it("rides on the peek with the agents' names from their states", () => {
        const peek = makePeek(
            input({
                states: states(agent("a", "working")),
                usage: { claude: reading("claude", [{ id: "5h", label: "5-hour", usedpercent: 80 }]) },
            })
        );
        expect(peek.usage.map((l) => [l.agent, l.label, l.percent, l.level])).toEqual([
            ["Claude Code", "5-hour", "80 % used", "warning"],
        ]);
    });
});
