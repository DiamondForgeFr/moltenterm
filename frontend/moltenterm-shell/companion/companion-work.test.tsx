// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentStateInfo } from "../agent-state-model";
import { I18nModel } from "../i18n/i18n";
import { ColumnsBand, TwoColumnMinWidth, workLayout } from "./companion-layout";
import {
    agentEnd,
    certainTicket,
    drawnLinks,
    dueText,
    hotEnds,
    linkAgents,
    linkPath,
    MaxMilestoneRows,
    MilestoneInfo,
    milestoneProgress,
    MilestonesView,
    offersSummaries,
    previewTickets,
    ticketEnd,
    ticketLinks,
    todoEnd,
    todoLinks,
} from "./companion-milestone-model";
import { CompanionSubagent, CompanionView } from "./companion-model";
import { agentsView } from "./companion-recap-model";
import { CompanionWork } from "./companion-work";

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const off = atom(false);
    return { openLink: vi.fn(), getSettingsKeyAtom: () => off };
});
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(), SetConfigCommand: vi.fn() } }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: null }) } }));

const Min = 60 * 1000;
const now = Date.UTC(2026, 10, 19, 12, 0, 0);

const working: AgentStateInfo = {
    blockid: "t1",
    agent: "claude",
    agentname: "Claude Code",
    state: "working",
    version: 1,
};

// Invented sub-agents of a lead session (#2392): one on its ticket's branch, one that names its ticket, one that names
// two tickets, one that names none.
const subagents: CompanionSubagent[] = [
    {
        id: "a",
        description: "Build the receipt e-mail",
        branch: "feature/38-receipt-language",
        background: true,
        state: "running",
        started: now - 4 * Min,
    },
    { id: "b", description: "#41 fix the checkout total", background: true, state: "running", started: now - 3 * Min },
    { id: "c", description: "Compare #35 with #41", background: true, state: "running", started: now - 2 * Min },
    { id: "d", description: "Review the docs", background: true, state: "running", started: now - 1 * Min },
];

function companionView(agent: string, agentname: string): CompanionView {
    return {
        blockid: "t1",
        version: 1,
        status: "live",
        agent,
        agentname,
        session: { path: "/s.jsonl", linkedby: "hook", branch: "develop" },
        todos: [
            { text: "Collect the merged PRs", status: "completed" },
            { text: "Review the docs", status: "in_progress" },
            { text: "Write the release notes", status: "pending" },
        ],
        subagents,
    };
}

function milestone(tickets: number): MilestoneInfo {
    return {
        number: 2,
        title: "1.0.0",
        url: "https://github.com/example/shop/milestone/2",
        open: tickets,
        closed: 12,
        due: Date.UTC(2026, 10, 22, 8, 0, 0),
        remaining: tickets,
        tickets: Array.from({ length: tickets }, (_, i) => {
            const number = [41, 38, 35][i] ?? 100 + i;
            return {
                number,
                title: `Ticket ${number} title`,
                url: `https://github.com/example/shop/issues/${number}`,
                sentence: number === 41 ? "Le total du panier ne s'affichera plus deux fois." : undefined,
            };
        }),
    };
}

const withMilestone: MilestonesView = { dir: "/w", state: "ok", milestone: milestone(12) };

function markup(view: CompanionView, milestones: MilestonesView, width: number, band?: ColumnsBand): string {
    return renderToStaticMarkup(
        <CompanionWork
            view={view}
            agentState={working}
            dir="/w"
            now={now}
            width={width}
            milestones={milestones}
            band={band}
            slots={{ topics: <i data-slot="topics" /> }}
        />
    );
}

function inFrench<T>(fn: () => T): T {
    const i18n = I18nModel.getInstance();
    try {
        i18n.setLanguageSetting("fr");
        return fn();
    } finally {
        i18n.setLanguageSetting("");
    }
}

describe("Tasks first (#2392)", () => {
    it.each([
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["kimi", "Kimi Code"],
    ])("puts the Tasks block above the agents at work in the %s companion, wide or narrow", (agent, name) => {
        for (const width of [380, 900]) {
            for (const milestones of [withMilestone, { dir: "/w", state: "none" } as MilestonesView]) {
                const html = markup(companionView(agent, name), milestones, width);
                const tasks = html.indexOf('data-testid="companion-tasks"');
                const agents = html.indexOf('data-testid="companion-agents"');
                expect(tasks).toBeGreaterThan(-1);
                expect(tasks).toBeLessThan(agents);
            }
        }
    });

    it("shows the agents alone when there is neither a milestone nor a task list", () => {
        const html = markup({ ...companionView("codex", "Codex"), todos: [] }, { dir: "/w", state: "noforge" }, 900);
        expect(html).not.toContain('data-testid="companion-tasks"');
        expect(html).toContain('data-testid="companion-agents"');
        expect(html).not.toContain("data-both");
    });

    it("waits for the milestone with the dominoes, never another spinner", () => {
        const html = markup(companionView("claude", "Claude Code"), { dir: "/w", state: "loading" }, 900);
        expect(html).toContain('data-testid="companion-milestone-loading"');
        expect(html).toContain("df-dominos");
        expect(html).toContain("Reading the milestone…");
    });
});

describe("the milestone block", () => {
    it("shows the name, progress, due date, up to 8 tickets with their sentence or title, and the rest", () => {
        const html = markup(companionView("claude", "Claude Code"), withMilestone, 900);
        expect(html).toContain(">1.0.0<");
        expect(html).toContain('data-testid="companion-milestone-progress">12/24<');
        expect(html).toContain("Due Nov 22");
        expect(html.match(/data-testid="companion-milestone-ticket"/g)).toHaveLength(MaxMilestoneRows);
        expect(html).toContain("Le total du panier ne s&#x27;affichera plus deux fois.");
        expect(html).toContain('title="Ticket title: Ticket 41 title"');
        expect(html).toContain(">Ticket 35 title<");
        expect(html).toContain('data-testid="companion-milestone-more">and 4 more<');
        expect(html).toContain("Open the milestone");
    });

    // #2392: the sentences are the developer's choice: offered once, discreetly, while they are off and the project's
    // agent can write them; never again once answered.
    it("offers the sentences once while they are off and an agent can write them", () => {
        const offered = { ...withMilestone, phrasable: true, summaries: false };
        const html = markup(companionView("claude", "Claude Code"), offered, 900);
        expect(html).toContain('data-testid="companion-summaries-offer"');
        expect(html).toContain("Explain each ticket in one sentence in your language?");
        expect(html).toContain(">Turn on<");
        expect(html).toContain(">No thanks<");
        const french = inFrench(() => markup(companionView("claude", "Claude Code"), offered, 900));
        expect(french).toContain("Expliquer chaque ticket en une phrase dans votre langue");
        expect(french).toContain(">Activer<");
        expect(french).toContain(">Non merci<");
        expect(offersSummaries(offered, false)).toBe(true);
        expect(offersSummaries(offered, true)).toBe(false);
        expect(offersSummaries({ ...offered, summaries: true }, false)).toBe(false);
        expect(offersSummaries({ ...offered, phrasable: false }, false)).toBe(false);
        expect(offersSummaries({ dir: "/w", state: "none", phrasable: true }, false)).toBe(false);
        expect(markup(companionView("codex", "Codex"), { ...offered, phrasable: false }, 900)).not.toContain(
            "companion-summaries-offer"
        );
    });

    it("reads in French", () => {
        const html = inFrench(() => markup(companionView("claude", "Claude Code"), withMilestone, 900));
        expect(html).toContain(">Tâches<");
        expect(html).toMatch(/Échéance le 22 nov/);
        expect(html).toContain("et 4 autres");
        expect(html).toContain("Ouvrir le jalon");
        expect(html).toContain("Les tâches de l&#x27;agent");
    });

    it("puts the tickets an agent works on first", () => {
        const view = companionView("claude", "Claude Code");
        const agents = linkAgents(agentsView(view, working, now).rows, view);
        const m = milestone(12);
        m.tickets = [...m.tickets.slice(3), ...m.tickets.slice(0, 3)];
        const { rows, more } = previewTickets(m, ticketLinks(m.tickets, agents), agents);
        expect(rows.slice(0, 2).map((r) => r.number)).toEqual([41, 38]);
        expect(rows).toHaveLength(MaxMilestoneRows);
        expect(more).toBe(4);
        // In the order their agents stand in, so that the lines do not cross, whatever the forge's order.
        m.tickets = [m.tickets.find((t) => t.number === 38), ...m.tickets.filter((t) => t.number !== 38)];
        expect(
            previewTickets(m, ticketLinks(m.tickets, agents))
                .rows.slice(0, 2)
                .map((r) => r.number)
        ).toEqual([38, 41]);
        expect(
            previewTickets(m, ticketLinks(m.tickets, agents), agents)
                .rows.slice(0, 2)
                .map((r) => r.number)
        ).toEqual([41, 38]);
    });

    it("counts its progress and words its due date", () => {
        expect(milestoneProgress(milestone(3))).toEqual({ closed: 12, total: 15, ratio: 0.8 });
        expect(dueText(Date.UTC(2026, 10, 19, 8), now, "en")).toEqual({ kind: "today", date: "Nov 19" });
        expect(dueText(Date.UTC(2026, 10, 10, 8), now, "en")?.kind).toBe("overdue");
        expect(dueText(Date.UTC(2027, 0, 10, 8), now, "en")).toEqual({ kind: "due", date: "Jan 10, 2027" });
        expect(dueText(0, now, "en")).toBeNull();
    });
});

function columnOf(html: string, testId: string): string {
    const at = html.indexOf(`data-testid="${testId}"`);
    const left = html.lastIndexOf('data-column="left"', at);
    const right = html.lastIndexOf('data-column="right"', at);
    return left < 0 && right < 0 ? "" : left > right ? "left" : "right";
}

describe("blocks by width", () => {
    it("stands side by side from the documented width, Tasks left and agents right; stacked below it", () => {
        expect(workLayout(TwoColumnMinWidth - 1)).toBe("stacked");
        expect(workLayout(TwoColumnMinWidth)).toBe("columns");
        const wide = markup(companionView("claude", "Claude Code"), withMilestone, 900);
        expect(wide).toContain('data-layout="columns" data-both=""');
        expect(columnOf(wide, "companion-tasks")).toBe("left");
        expect(columnOf(wide, "companion-agents")).toBe("right");
        const narrow = markup(companionView("claude", "Claude Code"), withMilestone, 380);
        expect(narrow).toContain('data-layout="stacked"');
        expect(narrow).not.toContain("data-column");
    });

    // #2395: the developer arranges the sections, and the area draws any band of the layout model.
    it("draws another band: its columns, its other sections, a line across whichever side the agents stand", () => {
        const view = companionView("claude", "Claude Code");
        const swapped: ColumnsBand = {
            kind: "columns",
            ids: ["agents", "topics", "tasks"],
            left: ["agents"],
            right: ["topics", "tasks"],
        };
        const html = markup(view, withMilestone, 900, swapped);
        expect(columnOf(html, "companion-agents")).toBe("left");
        expect(columnOf(html, "companion-tasks")).toBe("right");
        expect(html.indexOf('data-slot="topics"')).toBeLessThan(html.indexOf('data-testid="companion-tasks"'));
        expect(html).toContain('data-testid="companion-work-links"');
        const together: ColumnsBand = {
            kind: "columns",
            ids: ["tasks", "agents", "topics"],
            left: ["tasks", "agents"],
            right: ["topics"],
        };
        const same = markup(view, withMilestone, 900, together);
        expect(same).not.toContain('data-testid="companion-work-links"');
        expect(same.match(/data-testid="companion-work-chip"/g)).toHaveLength(3);
        const stacked = markup(view, withMilestone, 380, swapped);
        expect(stacked.indexOf('data-testid="companion-agents"')).toBeLessThan(
            stacked.indexOf('data-testid="companion-tasks"')
        );
    });

    // #2395: a developer who hides the Tasks block (the band has only the agents) or the agents at work.
    it("draws no line, no mark and no chip once the Tasks block is hidden; the agents stand alone", () => {
        const view = companionView("claude", "Claude Code");
        const agentsOnly: ColumnsBand = { kind: "columns", ids: ["agents"], left: [], right: ["agents"] };
        for (const width of [380, 900]) {
            const html = markup(view, withMilestone, width, agentsOnly);
            expect(html).toContain('data-testid="companion-agents"');
            expect(html).not.toContain('data-testid="companion-tasks"');
            expect(html).not.toContain('data-testid="companion-work-links"');
            expect(html).not.toContain('data-testid="companion-work-chip"');
            expect(html).not.toContain("data-linked");
        }
    });

    it("keeps the chips on the tasks when the agents at work are hidden: a link needs both blocks side by side", () => {
        const view = companionView("claude", "Claude Code");
        const tasksOnly: ColumnsBand = { kind: "columns", ids: ["tasks"], left: ["tasks"], right: [] };
        for (const width of [380, 900]) {
            const html = markup(view, withMilestone, width, tasksOnly);
            expect(html).toContain('data-testid="companion-tasks"');
            expect(html).not.toContain('data-testid="companion-agents"');
            expect(html).not.toContain('data-testid="companion-work-links"');
            expect(html.match(/data-testid="companion-work-chip"/g)).toHaveLength(3);
        }
    });

    it("draws a line only when the two blocks stand in the two columns of one band", () => {
        const view = companionView("claude", "Claude Code");
        const rightAndLeft: ColumnsBand = {
            kind: "columns",
            ids: ["agents", "tasks"],
            left: ["agents"],
            right: ["tasks"],
        };
        expect(markup(view, withMilestone, 900, rightAndLeft)).toContain('data-testid="companion-work-links"');
        const oneColumn: ColumnsBand = {
            kind: "columns",
            ids: ["tasks", "agents", "topics"],
            left: ["tasks", "agents"],
            right: ["topics"],
        };
        expect(markup(view, withMilestone, 900, oneColumn)).not.toContain('data-testid="companion-work-links"');
        const oneAgentColumn: ColumnsBand = {
            kind: "columns",
            ids: ["topics", "agents"],
            left: ["topics"],
            right: ["agents"],
        };
        expect(markup(view, withMilestone, 900, oneAgentColumn)).not.toContain('data-testid="companion-work-links"');
        // The Tasks block hidden while the agents stand in a column of a band of two: nothing to link to.
        const withoutTasks: ColumnsBand = {
            kind: "columns",
            ids: ["agents", "topics"],
            left: ["agents"],
            right: ["topics"],
        };
        const html = markup(view, withMilestone, 900, withoutTasks);
        expect(html).toContain("data-both");
        expect(html).not.toContain('data-testid="companion-work-links"');
        expect(html).not.toContain("data-linked");
    });

    it("leaves no gap for a band whose sections have nothing to show", () => {
        const view = { ...companionView("claude", "Claude Code"), todos: [] };
        const permissionOnly: ColumnsBand = { kind: "columns", ids: ["permission"], left: ["permission"], right: [] };
        const draw = (permission: React.ReactNode) =>
            renderToStaticMarkup(
                <CompanionWork
                    view={view}
                    agentState={working}
                    dir="/w"
                    now={now}
                    width={900}
                    milestones={withMilestone}
                    band={permissionOnly}
                    slots={{ permission }}
                />
            );
        expect(draw(null)).toContain('data-empty=""');
        expect(draw(<i data-slot="permission" />)).not.toContain("data-empty");
    });

    it("puts any section in a column, the Tasks block and the agents at work among them", () => {
        const view = companionView("claude", "Claude Code");
        const mixed: ColumnsBand = {
            kind: "columns",
            ids: ["topics", "tasks", "agents"],
            left: ["topics", "tasks"],
            right: ["agents"],
        };
        const html = markup(view, withMilestone, 900, mixed);
        expect(columnOf(html, "companion-tasks")).toBe("left");
        expect(columnOf(html, "companion-agents")).toBe("right");
        expect(html.indexOf('data-slot="topics"')).toBeLessThan(html.indexOf('data-testid="companion-tasks"'));
        expect(html).toContain('data-testid="companion-work-links"');
    });
});

describe("links from a task to its agent (#2392)", () => {
    const view = companionView("claude", "Claude Code");
    const agents = linkAgents(agentsView(view, working, now).rows, view);

    it("matches only a certain ticket: the agent's own branch, else the one ticket its description names", () => {
        expect(certainTicket("feature/38-receipt-language", "#99 something else")).toBe(38);
        expect(certainTicket("fix/7", "")).toBe(7);
        expect(certainTicket("worktree-agent-1", "#41 fix the checkout total")).toBe(41);
        expect(certainTicket("", "Compare #35 with #41")).toBe(0);
        expect(certainTicket("feature/v2-thing", "Review the docs")).toBe(0);
        expect(certainTicket("", "a#1 and &#39;")).toBe(0);
        // A #N elsewhere than at the start names another ticket as often as its own: never a link.
        expect(certainTicket("worktree-agent-2", "Port the fix from #2391")).toBe(0);
        expect(certainTicket("worktree-agent-3", "#2390 smooth the workspace switch")).toBe(2390);
        expect(certainTicket("", "  #2390 smooth")).toBe(2390);
        expect(Object.fromEntries(agents.map((a) => [a.id, a.ticket]))).toEqual({ main: 0, a: 38, b: 41, c: 0, d: 0 });
    });

    it("links the main agent only through its session's branch", () => {
        const onTicket = { ...view, session: { ...view.session, branch: "feature/35-search" } };
        const main = linkAgents(agentsView(onTicket, working, now).rows, onTicket).find((a) => a.id === "main");
        expect(main.ticket).toBe(35);
    });

    it("links the agent's own task only to the one agent whose description it is, or the one on the ticket it starts with", () => {
        const links = todoLinks(view.todos, agents);
        expect([...links.entries()].map(([i, a]) => [i, a.id])).toEqual([[1, "d"]]);
        const named = todoLinks([{ text: "#41 finish the checkout", status: "in_progress" }], agents);
        expect(named.get(0)?.id).toBe("b");
        expect(todoLinks([{ text: "Finish #41", status: "in_progress" }], agents).size).toBe(0);
        expect(todoLinks([{ text: "Port the fix from #2391", status: "in_progress" }], agents).size).toBe(0);
        const twice = [...agents, { ...agents.find((a) => a.id === "d"), id: "e" }];
        expect(todoLinks(view.todos, twice).size).toBe(0);
        expect(todoLinks([{ text: "Review the docs", status: "pending" }], agents).size).toBe(0);
        expect(todoLinks([{ text: "Review docs", status: "in_progress" }], agents).size).toBe(0);
    });

    it("draws a line per certain match when the blocks stand side by side, chips instead when they stack", () => {
        const m = milestone(12);
        const rows = previewTickets(m, ticketLinks(m.tickets, agents)).rows;
        const links = drawnLinks(rows, ticketLinks(m.tickets, agents), todoLinks(view.todos, agents));
        expect(links.map((l) => `${l.from}>${l.to}:${l.heat}`)).toEqual([
            "ticket:41>agent:b:running",
            "ticket:38>agent:a:running",
            "todo:1>agent:d:running",
        ]);
        const wide = markup(view, withMilestone, 900);
        expect(wide).toContain('data-testid="companion-work-links"');
        expect(wide).not.toContain('data-testid="companion-work-chip"');
        const narrow = markup(view, withMilestone, 380);
        expect(narrow).not.toContain('data-testid="companion-work-links"');
        expect(narrow.match(/data-testid="companion-work-chip"/g)).toHaveLength(3);
        expect(narrow).toContain("→ #41 fix the checkout total");
        expect(narrow).toContain("→ Review the docs");
        expect(narrow).not.toContain("→ Compare #35 with #41");
    });

    it("draws no line and no chip without a certain match", () => {
        const porting: CompanionSubagent = {
            id: "p",
            description: "Port the fix from #41",
            background: true,
            state: "running",
            started: now - Min,
        };
        const unsure = { ...view, subagents: [...subagents.filter((s) => s.id === "c"), porting], todos: [] };
        for (const width of [380, 900]) {
            const html = markup(unsure, withMilestone, width);
            expect(html).not.toContain('data-testid="companion-work-chip"');
            expect(html).not.toContain('data-testid="companion-work-links"');
            expect(html).not.toContain("data-linked");
        }
    });

    it("marks both ends of a link as its ends, and lights both from either end or the line", () => {
        const links = drawnLinks([{ number: 41, title: "t" }], ticketLinks([{ number: 41, title: "t" }], agents), null);
        for (const hot of [ticketEnd(41), agentEnd("b"), links[0].id]) {
            expect([...hotEnds(links, hot)].sort()).toEqual([agentEnd("b"), links[0].id, ticketEnd(41)].sort());
        }
        expect(hotEnds(links, todoEnd(0)).size).toBe(0);
        const html = markup(view, withMilestone, 900);
        expect(html).toContain('data-link-end="ticket:41" data-linked=""');
        expect(html).toContain('data-link-end="agent:b" data-linked=""');
        expect(html).toMatch(/data-link-end="ticket:35"(?! data-linked)/);
    });

    it("runs from the row's right edge to the card's first line, and only when the card stands to the right", () => {
        const link = { id: "x", from: "ticket:41", to: "agent:b", heat: "running" as const };
        const origin = { left: 100, top: 50, right: 900, bottom: 650 };
        const path = linkPath(
            link,
            { left: 120, top: 100, right: 400, bottom: 120 },
            { left: 440, top: 200, right: 860, bottom: 260 },
            origin
        );
        expect(path).toMatchObject({ x1: 302, y1: 60, x2: 338, y2: 160 });
        expect(path.d).toBe("M 302 60 C 320 60, 320 160, 338 160");
        const back = linkPath(
            link,
            { left: 440, top: 100, right: 860, bottom: 120 },
            { left: 120, top: 200, right: 400, bottom: 260 },
            origin
        );
        expect(back).toMatchObject({ x1: 338, y1: 60, x2: 302, y2: 160 });
        expect(back.d).toBe("M 338 60 C 320 60, 320 160, 302 160");
        expect(
            linkPath(
                link,
                { left: 120, top: 100, right: 400, bottom: 120 },
                { left: 120, top: 200, right: 400, bottom: 260 },
                origin
            )
        ).toBeNull();
        expect(
            linkPath(
                link,
                { left: 0, top: 0, right: 0, bottom: 0 },
                { left: 440, top: 200, right: 860, bottom: 260 },
                origin
            )
        ).toBeNull();
    });
});
