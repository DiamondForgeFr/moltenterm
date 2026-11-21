// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentStateInfo } from "../agent-state-model";
import { I18nModel } from "../i18n/i18n";
import { columnsFor, flowLayout, ListCap, TwoColumnsFromPx } from "./companion-flow-model";
import {
    AllLeads,
    EveryLead,
    Flore,
    Jerome,
    Julie,
    linksOf,
    nineOpen,
    NineTickets,
    panelOn,
    Remy,
    reviewsOf,
    subagent,
    ThisWorkspace,
    upcomingOf,
} from "./companion-holds-fixture";
import { classifyTickets, taskLists } from "./companion-holds-model";
import {
    agentEnd,
    certainTicket,
    chosenMilestone,
    daysLate,
    drawnLinks,
    dueText,
    hotEnds,
    linkAgents,
    linkPath,
    MaxMilestoneRows,
    MaxMilestoneTabs,
    MilestoneInfo,
    milestoneProgress,
    milestoneReady,
    milestoneStanding,
    MilestonesView,
    offersSummaries,
    splitTabs,
    tabLabel,
    tabRoom,
    ticketEnd,
    ticketLinks,
    todoEnd,
    todoLinks,
} from "./companion-milestone-model";
import { CompanionSubagent, CompanionView } from "./companion-model";
import { agentsView } from "./companion-recap-model";
import { TasksBlock } from "./companion-tasks";
import { CompanionWork } from "./companion-work";

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
        loaded: true,
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

// A milestone of the shop's forge as the tabs list it: v1.3.0 waits for its release (0 open, 36 closed), v1.4.0 has work.
function released(): MilestoneInfo {
    return {
        number: 13,
        title: "v1.3.0",
        url: "https://github.com/example/shop/milestone/13",
        open: 0,
        closed: 36,
        due: Date.UTC(2026, 10, 27),
        remaining: 0,
        loaded: true,
        tickets: [],
    };
}

function upcoming(): MilestoneInfo {
    return {
        number: 14,
        title: "v1.4.0",
        url: "https://github.com/example/shop/milestone/14",
        open: 3,
        closed: 1,
        due: Date.UTC(2026, 11, 18),
        remaining: 3,
        loaded: true,
        tickets: [201, 202, 203].map((number) => ({
            number,
            title: `Ticket ${number} title`,
            url: `https://github.com/example/shop/issues/${number}`,
        })),
    };
}

// Open milestones numbered after their version: 1.1.0 ... 1.N.0, each with a ticket of its own.
function manyMilestones(count: number): MilestoneInfo[] {
    return Array.from({ length: count }, (_, i) => ({
        number: 21 + i,
        title: `1.${i + 1}.0`,
        url: `https://github.com/example/shop/milestone/${21 + i}`,
        open: 1,
        closed: 0,
        remaining: 1,
        loaded: true,
        tickets: [{ number: 300 + i, title: `Ticket ${300 + i} title` }],
    }));
}

const withMilestone: MilestonesView = { dir: "/w", state: "ok", milestones: [milestone(12)] };
const shopTabs: MilestonesView = { dir: "/w", state: "ok", milestones: [released(), upcoming()] };

// Which of the pair the layout shows (#2395), and whether they stand side by side.
type Pair = { tasks?: boolean; agents?: boolean };

// A companion this wide, as the flow lays out the pair (companion-flow-model.ts): side by side from two columns, each
// block a column wide, the whole flow wide in one column.
function markup(view: CompanionView, milestones: MilestonesView, width: number, pair?: Pair, chosen?: number): string {
    const columns = columnsFor(width);
    const shows = { tasks: pair?.tasks !== false, agents: pair?.agents !== false };
    const flow = flowLayout(
        [
            { id: "tasks", height: 100 },
            { id: "agents", height: 100 },
        ].filter((b) => shows[b.id as keyof typeof shows]),
        width
    );
    return renderToStaticMarkup(
        <CompanionWork
            view={view}
            agentState={working}
            dir="/w"
            now={now}
            width={Math.floor(columns > 1 ? flow.columnWidth : flow.innerWidth)}
            paired={flow.paired}
            showTasks={shows.tasks}
            showAgents={shows.agents}
            milestones={milestones}
            chosen={chosen}
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
                if (milestones === withMilestone) {
                    expect(tasks).toBeGreaterThan(-1);
                    expect(tasks).toBeLessThan(agents);
                } else {
                    expect(tasks).toBe(-1);
                }
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
        expect(html).toContain('data-testid="companion-milestone-more">and 4 more to take<');
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
        expect(html).toContain('aria-label="Tâches"');
        expect(html).toContain('aria-label="Tâches par jalon"');
        expect(html).toContain("En cours chez moi");
        expect(html).toContain("À prendre");
        expect(html).toMatch(/Échéance le 22 nov/);
        expect(html).toContain("et 4 autres");
        expect(html).toContain("Ouvrir le jalon");
    });

    it("puts the tickets an agent works on first", () => {
        const view = companionView("claude", "Claude Code");
        const agents = linkAgents(agentsView(view, working, now).rows, view);
        const m = milestone(12);
        m.tickets = [...m.tickets.slice(3), ...m.tickets.slice(0, 3)];
        const none = new Map();
        const { rows, more } = taskLists(m, ticketLinks(m.tickets, agents), none, agents);
        expect(rows.slice(0, 2).map((r) => r.number)).toEqual([41, 38]);
        expect(rows).toHaveLength(MaxMilestoneRows);
        expect(more).toBe(4);
        // In the order their agents stand in, so that the lines do not cross, whatever the forge's order.
        m.tickets = [m.tickets.find((t) => t.number === 38), ...m.tickets.filter((t) => t.number !== 38)];
        expect(
            taskLists(m, ticketLinks(m.tickets, agents), none)
                .rows.slice(0, 2)
                .map((r) => r.number)
        ).toEqual([38, 41]);
        expect(
            taskLists(m, ticketLinks(m.tickets, agents), none, agents)
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

// The tabs of the milestones (#2416, TC-SHELL-018-7). The block's label is one tab per open milestone; each shows its own
// state, and a finished one that waits for its release keeps its tab.
describe("one tab per open milestone (#2416)", () => {
    const view = companionView("claude", "Claude Code");

    function tabsOf(html: string): { label: string; selected: boolean }[] {
        return [...html.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>(.*?)<\/button>/g)].map(
            (m) => ({ label: /class="mt-cb-chip-text">([^<]*)</.exec(m[2])?.[1] ?? "", selected: m[1] === "true" })
        );
    }

    it("shows v1.3.0 and v1.4.0 as two tabs, the oldest selected, v1.3.0 ready with 36/36 and no list", () => {
        const html = markup(view, shopTabs, 1400);
        expect(tabsOf(html)).toEqual([
            { label: "v1.3.0", selected: true },
            { label: "v1.4.0", selected: false },
        ]);
        expect(html).toContain('role="tablist" aria-label="Tasks by milestone"');
        expect(html).toContain('data-milestone="13" data-standing="ready"');
        expect(html).toContain('data-testid="companion-milestone-state"');
        expect(html).toContain("Ready to release");
        expect(html).toContain('title="36 of 36 closed" data-testid="companion-milestone-progress"');
        expect(html).toContain('<span class="text-primary">36</span> / 36 done');
        expect(html).toContain('data-testid="companion-milestone-ready"');
        expect(html).toContain("No tickets left");
        expect(html).toContain("Everything is merged. This milestone stays here until its release closes it.");
        expect(html).toContain("Prepare the release");
        expect(html).toContain("See the 36 tickets");
        expect(html).not.toContain('data-testid="companion-milestone-ticket"');
        expect(html).not.toContain("Ticket 201 title");
        // The ready tab wears its dot; the other tab wears none.
        const tabList = html.slice(
            html.indexOf('role="tablist"'),
            html.indexOf("</span></span>", html.indexOf("v1.4.0"))
        );
        expect(tabList.match(/data-state="ready"/g)).toHaveLength(1);
        expect(tabList.indexOf('data-state="ready"')).toBeLessThan(tabList.indexOf("v1.4.0"));
    });

    it("keeps the tab, the count and the placeholder when the finished milestone is the only one", () => {
        const html = markup(view, { dir: "/w", state: "ok", milestones: [released()] }, 380);
        expect(tabsOf(html)).toEqual([{ label: "v1.3.0", selected: true }]);
        expect(html).toContain('data-testid="companion-milestone-ready"');
        expect(html).toContain('data-testid="companion-milestone-progress"');
        expect(html).toContain(">36/36<");
        expect(html).toContain("Open the milestone");
    });

    it("shows the other tab's own state and tickets once it is chosen", () => {
        const html = markup(view, shopTabs, 1400, undefined, 14);
        expect(tabsOf(html)).toEqual([
            { label: "v1.3.0", selected: false },
            { label: "v1.4.0", selected: true },
        ]);
        expect(html).toContain('data-milestone="14"');
        expect(html).not.toContain('data-testid="companion-milestone-ready"');
        expect(html).toContain("Ticket 201 title");
        expect(html).toContain("Ticket 203 title");
        expect(html).toContain('<span class="text-primary">1</span> / 4 done');
        expect(html).toContain("Due Dec 18");
        expect(html).not.toContain("Prepare the release");
        // A choice that is no open milestone any more (its release closed it) falls to the oldest tab.
        expect(tabsOf(markup(view, shopTabs, 1400, undefined, 99)).map((t) => t.selected)).toEqual([true, false]);
    });

    it("links a task to its agent only inside the selected tab", () => {
        const onTicket: MilestonesView = {
            dir: "/w",
            state: "ok",
            milestones: [released(), { ...milestone(12), number: 2, title: "v1.5.0" }],
        };
        const second = markup(view, onTicket, 900, undefined, 2);
        expect(second).toContain('data-link-end="ticket:41" data-linked=""');
        const first = markup(view, onTicket, 900, undefined, 13);
        expect(first).not.toContain('data-link-end="ticket:41"');
        expect(first).not.toContain('data-testid="companion-milestone-ticket"');
    });

    it("says how late a milestone is, with a diamond and the words, and when a finished one is due", () => {
        const late: MilestonesView = {
            dir: "/w",
            state: "ok",
            milestones: [{ ...upcoming(), due: Date.UTC(2026, 9, 29) }],
        };
        const wide = markup(view, late, 1400);
        expect(wide).toContain('data-standing="late"');
        expect(wide).toContain("21 days late");
        expect(wide).toContain('data-state="blocked"');
        expect(wide).not.toContain('data-testid="companion-milestone-due"');
        expect(markup(view, late, 380)).toContain("21 d late");
        expect(inFrench(() => markup(view, late, 1400))).toContain("En retard de 21 jours");
        expect(inFrench(() => markup(view, late, 380))).toContain("21 j de retard");
        const ready = markup(view, shopTabs, 1400);
        expect(ready).toContain("Due Nov 27");
        expect(ready).not.toContain('data-state="blocked"');
    });

    it("reads in French: the ready badge, the placeholder and its actions", () => {
        const html = inFrench(() => markup(view, shopTabs, 1400));
        expect(html).toContain("Prête à sortir");
        expect(html).toContain("Plus aucun ticket");
        expect(html).toContain("Tout est mergé. Ce jalon reste ici jusqu&#x27;à sa release, qui le fermera.");
        expect(html).toContain("Préparer la release");
        expect(html).toContain("Voir les 36 tickets");
        expect(html).toContain("/ 36 faits");
        expect(html).toContain('aria-label="Tâches par jalon"');
    });

    it("keeps four tabs at most, the rest behind a +N chip, and the chosen tab always visible", () => {
        const list = manyMilestones(6);
        const wide = markup(view, { dir: "/w", state: "ok", milestones: list }, 1400);
        expect(tabsOf(wide).map((t) => t.label)).toEqual(["1.1.0", "1.2.0", "1.3.0", "1.4.0"]);
        expect(wide).toContain('aria-haspopup="menu"');
        expect(wide).toContain(">+2<");
        expect(wide).toContain('title="2 more milestones"');
        const fifth = markup(view, { dir: "/w", state: "ok", milestones: list }, 1400, undefined, 25);
        expect(tabsOf(fifth)).toEqual([
            { label: "1.1.0", selected: false },
            { label: "1.2.0", selected: false },
            { label: "1.3.0", selected: false },
            { label: "1.5.0", selected: true },
        ]);
        expect(fifth).toContain("Ticket 304 title");
        const five = manyMilestones(5);
        expect(markup(view, { dir: "/w", state: "ok", milestones: five }, 1400)).toContain(">+1<");
        expect(markup(view, { dir: "/w", state: "ok", milestones: manyMilestones(4) }, 1400)).not.toContain(">+");
    });

    it("never wraps the tab row: a narrow block shows fewer tabs and the rest behind +N", () => {
        const list = manyMilestones(4);
        const stacked = markup(view, { dir: "/w", state: "ok", milestones: list }, 330);
        const shown = tabsOf(stacked).length;
        expect(shown).toBeGreaterThanOrEqual(1);
        expect(shown).toBeLessThan(4);
        expect(stacked).toContain(`>+${4 - shown}<`);
        expect(tabsOf(markup(view, { dir: "/w", state: "ok", milestones: list }, 380))).toHaveLength(4);
        const wide = markup(view, { dir: "/w", state: "ok", milestones: list }, 1400);
        expect(tabsOf(wide)).toHaveLength(4);
        expect(wide).not.toContain(">+");
    });

    it("waits for the tickets of a milestone past the first tabs, with the dominoes", () => {
        const unread: MilestonesView = {
            dir: "/w",
            state: "ok",
            milestones: [{ ...upcoming(), loaded: false, tickets: [] }],
        };
        const html = markup(view, unread, 900);
        expect(html).toContain('data-testid="companion-milestone-loading"');
        expect(html).toContain("df-dominos");
        expect(html).not.toContain('data-testid="companion-milestone-ticket"');
    });

    it("shows a milestone with no issue at all as empty, never as ready", () => {
        const empty: MilestoneInfo = { ...upcoming(), open: 0, closed: 0, remaining: 0, tickets: [] };
        const html = markup(view, { dir: "/w", state: "ok", milestones: [empty] }, 900);
        expect(html).toContain('data-testid="companion-milestone-empty"');
        expect(html).toContain("No ticket in this milestone yet.");
        expect(html).not.toContain("companion-milestone-ready");
        expect(html).not.toContain("Ready to release");
    });

    it("leaves the plan to the hero (#2441): the pair draws the milestone and the sub-agents only", () => {
        const html = markup(view, shopTabs, 900);
        expect(html).not.toContain('data-testid="companion-plan"');
        expect(html).toContain('data-testid="companion-milestone-ready"');
        const alone = markup(view, { dir: "/w", state: "none" }, 900);
        expect(alone).not.toContain('data-testid="companion-tasks"');
        expect(alone).toContain('data-testid="companion-agents"');
    });

    it("opens the milestone from the last row of its block", () => {
        const html = markup(view, shopTabs, 900);
        expect(html).toMatch(/class="mt-cb-foot"><button[^>]*data-testid="companion-milestone-open"/);
    });
});

describe("the tabs' model (#2416)", () => {
    const four = manyMilestones(4);
    const six = manyMilestones(6);

    it("opens on the oldest open milestone, or on the one the developer chose while it is open", () => {
        expect(chosenMilestone(six, 0).number).toBe(21);
        expect(chosenMilestone(six, 24).number).toBe(24);
        expect(chosenMilestone(six, 999).number).toBe(21);
        expect(chosenMilestone([], 24)).toBeNull();
    });

    it("splits the tabs from the +N menu, the chosen tab taking the last place when it comes later", () => {
        const names = (list: MilestoneInfo[]) => list.map((m) => m.title);
        expect(names(splitTabs(six, 21, 4).shown)).toEqual(["1.1.0", "1.2.0", "1.3.0", "1.4.0"]);
        expect(names(splitTabs(six, 21, 4).more)).toEqual(["1.5.0", "1.6.0"]);
        const chosen = splitTabs(six, 26, 4);
        expect(names(chosen.shown)).toEqual(["1.1.0", "1.2.0", "1.3.0", "1.6.0"]);
        expect(names(chosen.more)).toEqual(["1.4.0", "1.5.0"]);
        expect(names(splitTabs(six, 21, 2).shown)).toEqual(["1.1.0", "1.2.0"]);
        expect(names(splitTabs(six, 26, 2).shown)).toEqual(["1.1.0", "1.6.0"]);
        expect(splitTabs(six, 21, 0).shown).toHaveLength(1);
        expect(splitTabs(four, 21, 99).shown).toHaveLength(MaxMilestoneTabs);
        expect(splitTabs(four, 21, 99).more).toEqual([]);
        expect(splitTabs([], 0, 4)).toEqual({ shown: [], more: [] });
    });

    it("counts the tabs that fit a width, with room for the +N chip when they do not all fit", () => {
        const tabs = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `1.${i}.0`, marked: false }));
        expect(tabRoom(tabs(2), 400)).toBe(2);
        expect(tabRoom(tabs(4), 1000)).toBe(4);
        expect(tabRoom(tabs(6), 1000)).toBe(4);
        // Four tabs of this size need about 264 px. A width short of that keeps the ones that fit beside a +N chip.
        expect(tabRoom(tabs(4), 330)).toBe(4);
        expect(tabRoom(tabs(4), 250)).toBe(3);
        expect(tabRoom(tabs(4), 200)).toBe(2);
        expect(tabRoom(tabs(3), 10)).toBe(1);
        expect(tabRoom([], 300)).toBe(0);
        expect(tabRoom([{ label: "1.0.0", marked: true }], 80)).toBe(1);
        expect(tabLabel("A very long milestone title")).toBe("A very long m…");
        expect(tabLabel("v1.3.0")).toBe("v1.3.0");
    });

    it("tells a finished milestone from a late one, never both", () => {
        const base = upcoming();
        expect(milestoneReady(released())).toBe(true);
        expect(milestoneReady({ ...base, open: 0, closed: 0 })).toBe(false);
        expect(milestoneReady(base)).toBe(false);
        expect(milestoneStanding(released(), now)).toBe("ready");
        // A finished milestone past its due date is still ready: its work is done.
        expect(milestoneStanding({ ...released(), due: Date.UTC(2026, 9, 1) }, now)).toBe("ready");
        expect(milestoneStanding({ ...base, due: Date.UTC(2026, 9, 29) }, now)).toBe("late");
        expect(milestoneStanding(base, now)).toBe("");
        expect(milestoneStanding({ ...base, due: undefined }, now)).toBe("");
        expect(milestoneStanding({ ...base, due: Date.UTC(2026, 10, 19, 8) }, now)).toBe("");
    });

    it("counts whole days late from the day the forge holds", () => {
        expect(daysLate(Date.UTC(2026, 9, 29), now)).toBe(21);
        expect(daysLate(Date.UTC(2026, 10, 18, 23, 59), now)).toBe(1);
        expect(daysLate(Date.UTC(2026, 10, 19, 8), now)).toBe(0);
        expect(daysLate(Date.UTC(2026, 11, 18), now)).toBe(0);
        expect(daysLate(0, now)).toBe(0);
    });
});

describe("the linked pair in the flow (#2441)", () => {
    it("stands side by side from two columns, its lines drawn; flows in one column, the chips carrying the links", () => {
        expect(columnsFor(TwoColumnsFromPx - 1)).toBe(1);
        expect(columnsFor(TwoColumnsFromPx)).toBe(2);
        const view = companionView("claude", "Claude Code");
        const wide = markup(view, withMilestone, 900);
        expect(wide.indexOf('data-testid="companion-tasks"')).toBeLessThan(
            wide.indexOf('data-testid="companion-agents"')
        );
        expect(wide).toContain('data-testid="companion-work-links"');
        expect(wide).toContain('data-flow-id="tasks"');
        expect(wide).toContain('data-flow-id="agents"');
        const narrow = markup(view, withMilestone, 380);
        expect(narrow).not.toContain('data-testid="companion-work-links"');
        expect(narrow.match(/data-testid="companion-work-chip"/g)).toHaveLength(2);
        // The chips stay beside the lines: "→ name" says who works on a ticket at any width.
        expect(wide.match(/data-testid="companion-work-chip"/g)).toHaveLength(2);
    });

    it("draws no line, no mark and no chip once the milestone is hidden; the agents stand alone", () => {
        const view = companionView("claude", "Claude Code");
        for (const width of [380, 900]) {
            const html = markup(view, withMilestone, width, { tasks: false });
            expect(html).toContain('data-testid="companion-agents"');
            expect(html).not.toContain('data-testid="companion-tasks"');
            expect(html).not.toContain('data-testid="companion-work-links"');
            expect(html).not.toContain('data-testid="companion-work-chip"');
            expect(html).not.toContain("data-linked");
        }
    });

    it("keeps the chips on the tickets when the agents at work are hidden, and draws no line", () => {
        const view = companionView("claude", "Claude Code");
        for (const width of [380, 900]) {
            const html = markup(view, withMilestone, width, { agents: false });
            expect(html).toContain('data-testid="companion-tasks"');
            expect(html).not.toContain('data-testid="companion-agents"');
            expect(html).not.toContain('data-testid="companion-work-links"');
            expect(html.match(/data-testid="companion-work-chip"/g)).toHaveLength(2);
        }
    });

    it("lists the sub-agents only, the main agent being the hero, eight then 'and N more'", () => {
        const many: CompanionSubagent[] = Array.from({ length: 11 }, (_, i) => ({
            id: `s${i}`,
            description: `Task ${i}`,
            state: "running",
            started: now - (i + 1) * Min,
        }));
        const html = markup({ ...companionView("claude", "Claude Code"), subagents: many }, withMilestone, 900);
        expect(html).not.toContain('data-testid="companion-agent-main"');
        expect(html.match(/data-testid="companion-subagent"/g)).toHaveLength(ListCap);
        expect(html).toContain('data-testid="companion-subagents-more"');
        expect(html).toContain("and 3 more");
    });

    it("says so when the main agent has no sub-agent yet", () => {
        const html = markup({ ...companionView("claude", "Claude Code"), subagents: [] }, withMilestone, 900);
        expect(html).toContain('data-testid="companion-subagents-none"');
    });
});

// Who works on what (#2418, TC-SHELL-018-8): the developer's case, Lead A's companion. A (Claude Code) has three
// sub-agents on tickets 1 to 3, B (Kimi) two on 4 and 5, C (Claude Code) one on 6; 7 to 9 are free.
describe("who works on what (#2418)", () => {
    const leadState: AgentStateInfo = { ...Flore, blockid: "flore" };

    function leadView(lead: AgentStateInfo, mine: number[]): CompanionView {
        return {
            blockid: lead.blockid,
            version: 1,
            status: "live",
            agent: lead.agent,
            agentname: lead.agentname,
            session: { path: "/s.jsonl", linkedby: "hook", branch: "develop" },
            todos: [],
            subagents: mine.map((n, i) => ({
                id: `s${n}`,
                kind: i === 0 ? "sf-fix" : "sf-build",
                description: `#${n} work on the ticket`,
                branch: `feature/${n}-work`,
                background: true,
                state: "running" as const,
                started: now - (i + 1) * 20 * Min,
            })),
        };
    }

    const nine: MilestonesView = { dir: "/shop", state: "ok", milestones: [nineOpen()] };
    const holds = { upcoming: AllLeads, states: EveryLead };

    function render(
        lead: AgentStateInfo,
        mine: number[],
        width: number,
        extra: Partial<React.ComponentProps<typeof CompanionWork>> = {}
    ): string {
        return renderToStaticMarkup(
            <CompanionWork
                view={leadView(lead, mine)}
                agentState={{ ...lead, workspaceid: ThisWorkspace }}
                dir="/shop"
                now={now}
                width={width >= TwoColumnsFromPx ? Math.floor((width - 72) / 2) : width - 48}
                paired={width >= TwoColumnsFromPx}
                milestones={nine}
                holds={holds}
                {...extra}
            />
        );
    }

    const ticketRows = (html: string) => [...html.matchAll(/data-link-end="ticket:(\d+)"/g)].map((m) => Number(m[1]));

    it("lists A's own tickets, then the free ones, and the tickets other agents hold apart, under their owners", () => {
        const html = render(Flore, [1, 2, 3], 1400);
        expect(ticketRows(html)).toEqual([1, 2, 3, 7, 8, 9]);
        expect(html).toContain('data-testid="companion-taken"');
        expect(html).toContain(">Taken by others<");
        const group = html.slice(
            html.indexOf('data-testid="companion-taken"'),
            html.indexOf('data-testid="companion-agents"')
        );
        expect(group.match(/data-testid="companion-taken-ticket"/g)).toHaveLength(3);
        expect(group.match(/Jérôme · Kimi Code/g)).toHaveLength(2);
        expect(group.match(/Julie · Claude Code/g)).toHaveLength(1);
        expect(group).toContain("#4");
        expect(group).toContain("#6");
        // Sub-agents of their leads: said, and a click goes to the lead's panel.
        expect(group.match(/title="Sub-agent of Jérôme"/g)).toHaveLength(2);
        expect(group).toContain('title="Sub-agent of Julie"');
        expect(group.match(/data-testid="companion-taken-owner"/g)).toHaveLength(3);
        // Never work to do: no link end, no sentence, no chip.
        expect(group).not.toContain("data-link-end");
        expect(group).not.toContain("data-translated");
        expect(html).not.toContain('data-link-end="ticket:4"');
    });

    it("lists B's own tickets in B's companion, and C's in C's, with the same free tickets", () => {
        const b = render(Jerome, [4, 5], 1400);
        expect(ticketRows(b)).toEqual([4, 5, 7, 8, 9]);
        expect(b).toContain("Flore · Claude Code");
        const c = render(Julie, [6], 1400);
        expect(ticketRows(c)).toEqual([6, 7, 8, 9]);
    });

    it("counts the milestone's tickets by holder, and 'and N more to take' never counts what others hold", () => {
        const html = render(Flore, [1, 2, 3], 1400);
        expect(html).toContain('data-testid="companion-milestone-strip"');
        expect(html).toContain(">9 left<");
        expect(html).toContain('<span data-kind="mine">3 here</span>');
        expect(html).toContain('<span data-kind="other">3 with others</span>');
        expect(html).toContain('<span data-kind="free">3 to take</span>');
        const squares = html.slice(html.indexOf("mt-cwork-squares"), html.indexOf("mt-cwork-counts"));
        expect(squares.match(/data-kind="mine"/g)).toHaveLength(3);
        expect(squares.match(/data-kind="other"/g)).toHaveLength(3);
        expect(squares.match(/data-kind="free"/g)).toHaveLength(3);
        expect(html).not.toContain('data-testid="companion-milestone-more"');
        // The header keeps the real progress of the whole milestone.
        expect(html).toContain('data-testid="companion-milestone-progress"');
        expect(html).toContain('<span class="text-primary">3</span> / 12 done');
    });

    it("says the sections in French", () => {
        const html = inFrench(() => render(Flore, [1, 2, 3], 1400));
        expect(html).toContain(">Pris par d&#x27;autres<");
        expect(html).toContain("3 chez d&#x27;autres");
        expect(html).toContain("3 chez moi");
        expect(html).toContain("3 à prendre");
        expect(html).toContain("Reste 9");
        expect(html).toContain('title="Sous-agent de Jérôme"');
    });

    it("folds the group to one line with the owners' names on a narrow block, and opens it when the developer did", () => {
        const narrow = render(Flore, [1, 2, 3], 380);
        expect(narrow).toContain('aria-expanded="false"');
        expect(narrow).toContain("Jérôme, Julie");
        expect(narrow).not.toContain('data-testid="companion-taken-ticket"');
        expect(narrow).toContain('<span class="mt-cwork-n">3</span>');
        const wide = render(Flore, [1, 2, 3], 1400);
        expect(wide).toContain('aria-expanded="true"');
        expect(wide).not.toContain('class="mt-cwork-names"');
        const html = (open: boolean | undefined, width: number) =>
            renderToStaticMarkup(
                <TasksBlock
                    loading={false}
                    milestones={[nineOpen()]}
                    selected={nineOpen()}
                    onSelect={() => {}}
                    width={width}
                    lists={taskLists(
                        nineOpen(),
                        linksOf(1, 2, 3),
                        classifyTickets(NineTickets, {
                            mine: linksOf(1, 2, 3),
                            ownBlockId: "flore",
                            workspaceId: ThisWorkspace,
                            upcoming: AllLeads,
                            reviews: null,
                            states: EveryLead,
                        })
                    )}
                    takenOpen={open}
                    onTakenChange={() => {}}
                    phrasing={false}
                    offer={null}
                    links={linksOf(1, 2, 3)}
                    now={now}
                    chips={false}
                    lit={new Set()}
                    ends={new Set()}
                />
            );
        // His choice wins over the width, both ways.
        expect(html(true, 300)).toContain('aria-expanded="true"');
        expect(html(false, 900)).toContain('aria-expanded="false"');
        expect(html(undefined, 900)).toContain('aria-expanded="true"');
        expect(html(undefined, 300)).toContain('aria-expanded="false"');
    });

    it("names a taken ticket by its board status, its pull request or its branch when no agent holds it", () => {
        const tickets = nineOpen();
        tickets.tickets = tickets.tickets.map((t) => (t.number === 8 ? { ...t, status: "In progress" } : t));
        const none = upcomingOf([], [{ branch: "feature/9-x", ticket: 9, ahead: 1, worktree: "/shop/.worktrees/9" }]);
        const html = render(Flore, [], 1400, {
            milestones: { dir: "/shop", state: "ok", milestones: [tickets] },
            holds: {
                upcoming: none,
                states: EveryLead,
                reviews: reviewsOf({
                    number: 91,
                    ticket: 7,
                    branch: "feature/7-x",
                    url: "https://example.test/pull/91",
                }),
            },
        });
        expect(ticketRows(html)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(html).toContain('data-testid="companion-taken-status">In progress<');
        expect(html).toContain('data-testid="companion-taken-pr">PR #91<');
        expect(html).toContain('data-testid="companion-taken-branch">On a branch<');
        expect(html).not.toContain('data-testid="companion-taken-owner"');
    });

    it("takes a ticket an agent of another workspace holds out of the list without naming that agent", () => {
        const html = render(Flore, [], 1400, {
            holds: { upcoming: upcomingOf([panelOn(Remy, "feature/5-x")]), states: EveryLead },
        });
        expect(ticketRows(html)).not.toContain(5);
        expect(html).toContain('data-testid="companion-taken-away">In another workspace<');
        expect(html).not.toContain("Rémy");
        expect(html).not.toContain("Codex");
    });

    it("gives a ticket back when its sub-agent finishes, and shows no group when nobody holds anything", () => {
        const done = upcomingOf([panelOn(Jerome, "develop"), subagent(Jerome, 4, "done")]);
        const html = render(Flore, [], 1400, { holds: { upcoming: done, states: EveryLead } });
        expect(ticketRows(html)).toContain(4);
        expect(html).not.toContain('data-testid="companion-taken"');
        expect(html).not.toContain("companion-taken-head");
    });

    it("draws each sub-agent with its ticket, tier, model and duration, the main agent being the hero (#2441)", () => {
        const html = render(Flore, [1, 2, 3], 1400, { agentState: { ...leadState, model: "claude-opus-5-5" } });
        expect(html.match(/data-testid="companion-subagent"/g)).toHaveLength(3);
        expect(html).toContain('<span class="mt-cwork-sub-id">#1</span>work on the ticket');
        expect(html).toContain("sf-fix · Opus 5.5 · background · 20 min");
        expect(html).toContain("sf-build · Opus 5.5 · background · 40 min");
        expect(html).toContain("sf-build · Opus 5.5 · background · 1 h 00");
        expect(html).toContain('<span class="mt-cwork-sub-state" data-state="running">running</span>');
        // A line leaves each task for the sub-agent building it.
        expect(html).toContain('data-testid="companion-work-links"');
        expect(html).toContain('data-link-end="agent:s1" data-linked=""');
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

    it("draws a line per certain match when the blocks stand side by side, the chips at every width", () => {
        const m = milestone(12);
        const rows = taskLists(m, ticketLinks(m.tickets, agents), new Map()).rows;
        const links = drawnLinks(rows, ticketLinks(m.tickets, agents), todoLinks(view.todos, agents));
        expect(links.map((l) => `${l.from}>${l.to}:${l.heat}`)).toEqual([
            "ticket:41>agent:b:running",
            "ticket:38>agent:a:running",
            "todo:1>agent:d:running",
        ]);
        const wide = markup(view, withMilestone, 900);
        expect(wide).toContain('data-testid="companion-work-links"');
        expect(wide.match(/data-testid="companion-work-chip"/g)).toHaveLength(2);
        const narrow = markup(view, withMilestone, 380);
        expect(narrow).not.toContain('data-testid="companion-work-links"');
        expect(narrow.match(/data-testid="companion-work-chip"/g)).toHaveLength(2);
        expect(narrow).toContain("→ #41 fix the checkout total");
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
