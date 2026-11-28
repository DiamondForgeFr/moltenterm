// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentStateInfo } from "../agent-state-model";
import { AgentsBlockBody } from "./companion-agents";
import { linkAgents, MilestoneTicket, namedTicket, subagentTickets, ticketLinks } from "./companion-milestone-model";
import { CompanionSubagent, CompanionView } from "./companion-model";
import { agentsView } from "./companion-recap-model";

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const off = atom(false);
    return { openLink: vi.fn(), getSettingsKeyAtom: () => off, getApi: () => ({}) };
});
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: { getInstance: () => ({ showContextMenu: vi.fn() }) },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(), SetConfigCommand: vi.fn() } }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: null }) } }));

// #2587, with invented tickets: a lead delegates the planning of two milestone tickets to background sub-agents whose
// descriptions name their ticket at the end; the second planner starts Explore agents of its own.

const Min = 60 * 1000;
const now = Date.UTC(2026, 10, 28, 12, 0, 0);

const working: AgentStateInfo = {
    blockid: "t1",
    agent: "claude",
    agentname: "Claude Code",
    state: "working",
    version: 1,
};

const tickets: MilestoneTicket[] = [
    { number: 41, title: "Checkout total" },
    { number: 38, title: "Receipt e-mail" },
];

function planner(
    id: string,
    agentid: string,
    description: string,
    extra?: Partial<CompanionSubagent>
): CompanionSubagent {
    return {
        id,
        agentid,
        description,
        kind: "sf-plan",
        background: true,
        state: "running",
        started: now - 10 * Min,
        ...extra,
    };
}

function explore(id: string, parentid: string, description: string, started: number): CompanionSubagent {
    return {
        id,
        agentid: `agent-${id}`,
        parentid,
        description,
        kind: "Explore",
        background: true,
        state: "running",
        started,
    };
}

const subagents: CompanionSubagent[] = [
    planner("p1", "agent-p1", "Plan + mockup #41"),
    // Waiting on its Explore agents: wavesrv keeps it at work (pkg/molten/companion/topics.go Subagents).
    planner("p2", "agent-p2", "Analyse + plan #38", { waiting: true, started: now - 12 * Min }),
    explore("e1", "agent-p2", "Find the ticket links", now - 3 * Min),
    explore("e2", "agent-p2", "Read the hold model", now - 2 * Min),
    explore("e3", "agent-e2", "Grep the transcripts", now - Min),
];

function viewOf(subs: CompanionSubagent[]): CompanionView {
    return {
        blockid: "t1",
        version: 1,
        status: "live",
        agent: "claude",
        agentname: "Claude Code",
        session: { path: "/s.jsonl", linkedby: "hook", branch: "develop" },
        subagents: subs,
    };
}

describe("the ticket a sub-agent's description names (#2587)", () => {
    it("takes the one ticket named anywhere, none for none, none for two", () => {
        expect(namedTicket("Plan + mockup #41")).toBe(41);
        expect(namedTicket("#41 plan")).toBe(41);
        expect(namedTicket("Plan the receipt")).toBe(0);
        expect(namedTicket("Compare #35 with #41")).toBe(0);
        expect(namedTicket("Plan #41, then check #41 again")).toBe(41);
        expect(namedTicket("a#1 and &#39;")).toBe(0);
        expect(namedTicket(undefined)).toBe(0);
    });

    it("links a ticket of the milestone only: one, none, two, and a number that is no milestone ticket", () => {
        const agentsOf = (description: string) => [
            { id: "x", name: "x", state: "running" as const, ticket: namedTicket(description), description },
        ];
        expect(
            ticketLinks(tickets, agentsOf("Plan + mockup #41"))
                .get(41)
                ?.map((a) => a.id)
        ).toEqual(["x"]);
        expect(ticketLinks(tickets, agentsOf("Plan the receipt")).size).toBe(0);
        expect(ticketLinks(tickets, agentsOf("Compare #38 with #41")).size).toBe(0);
        expect(ticketLinks(tickets, agentsOf("Port the fix from #999")).size).toBe(0);
    });
});

describe("a sub-agent's own sub-agents (#2587)", () => {
    const view = viewOf(subagents);

    it("carry the ticket of the sub-agent that started them, up its parents", () => {
        const byRow = subagentTickets(subagents);
        expect(Object.fromEntries(byRow)).toEqual({ p1: 41, p2: 38, e1: 38, e2: 38, e3: 38 });
        const own = subagentTickets([...subagents, explore("e4", "agent-p2", "#41 check the total", now)]);
        expect(own.get("e4")).toBe(41);
        // A session's own sub-agent never takes another's ticket, nor one whose parent is gone.
        const orphan = subagentTickets([explore("e5", "agent-gone", "Read the docs", now)]);
        expect(orphan.get("e5")).toBe(0);
    });

    it("link to their parent's milestone ticket, the planners to theirs", () => {
        const agents = linkAgents(agentsView(view, working, now).rows, view);
        const links = ticketLinks(tickets, agents);
        expect(links.get(41)?.map((a) => a.id)).toEqual(["p1"]);
        expect(
            links
                .get(38)
                ?.map((a) => a.id)
                .sort()
        ).toEqual(["e1", "e2", "e3", "p2"]);
    });

    it("sit right under the sub-agent that started them, and the waiting planner stays at work", () => {
        const rows = agentsView(view, working, now).rows.filter((r) => !r.main);
        expect(rows.map((r) => [r.id, r.depth ?? 0])).toEqual([
            ["p2", 0],
            ["e2", 1],
            ["e3", 2],
            ["e1", 1],
            ["p1", 0],
        ]);
        expect(rows.find((r) => r.id === "p2")?.waiting).toBe(true);
    });

    it("keep their place when their parent is not at work, and a loop in the records lists each once", () => {
        const gone = agentsView(viewOf([explore("e1", "agent-p9", "Find the links", now)]), working, now).rows;
        expect(gone.filter((r) => !r.main).map((r) => [r.id, r.depth ?? 0])).toEqual([["e1", 0]]);
        const loop = agentsView(
            viewOf([explore("x", "agent-y", "one", now - Min), explore("y", "agent-x", "two", now)]),
            working,
            now
        ).rows;
        expect(loop.filter((r) => !r.main).map((r) => r.id)).toEqual(["y", "x"]);
    });

    it("are drawn indented under their parent, with its ticket", () => {
        const rows = agentsView(view, working, now).rows;
        const html = renderToStaticMarkup(<AgentsBlockBody rows={rows} view={view} marks={null} ended="" now={now} />);
        expect(html).toContain('data-link-end="agent:e3"');
        expect(html).toMatch(/data-link-end="agent:e3"[^>]*data-depth="2"[^>]*style="--mt-cwork-sub-depth:2"/);
        expect(html).toMatch(/data-link-end="agent:p2"(?![^>]*data-depth)/);
        expect(html).toContain('<span class="mt-cwork-sub-id">#38</span>Grep the transcripts');
    });
});
