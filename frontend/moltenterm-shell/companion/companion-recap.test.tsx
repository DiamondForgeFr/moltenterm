// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentStateInfo } from "../agent-state-model";
import { FilesSection, FilesShown } from "./companion-files";
import { fileGroups, filterFiles, fuzzyScore, readCompanionPrefs } from "./companion-files-model";
import { CompanionHero } from "./companion-hero";
import { CompanionFile, CompanionView } from "./companion-model";
import { RecentTopicsSection } from "./companion-recap";
import { agentsView, branchTicket, finishedLabel, mainAgentRow, topicRows } from "./companion-recap-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: null }) } }));

const Min = 60 * 1000;
const now = new Date(2026, 9, 13, 12, 0, 0).getTime();

const working: AgentStateInfo = {
    blockid: "t1",
    agent: "claude",
    agentname: "Claude Code",
    state: "working",
    version: 1,
    model: "claude-opus-5-5",
    modelname: "Opus",
    effort: "high",
};

// What wavesrv sends for an invented Claude Code session (pkg/molten/companion/topics.go).
const view: CompanionView = {
    blockid: "t1",
    version: 3,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    session: { path: "/s.jsonl", linkedby: "hook", name: "Checkout fixes and release notes" },
    todos: [
        { text: "Collect the merged PRs", status: "completed" },
        { text: "Write the release notes", status: "in_progress" },
    ],
    topics: [
        {
            text: "Write the release notes for 2.4",
            branch: "feature/43-release-notes",
            at: now - 10 * Min,
            last: now - 2 * Min,
            files: 1,
            tools: 6,
        },
        {
            text: "Fix the checkout total",
            branch: "main",
            at: now - 60 * Min,
            last: now - 50 * Min,
            files: 2,
            prs: [{ number: 812 }],
        },
    ],
    subagents: [
        {
            id: "a",
            description: "Audit the docs",
            kind: "general-purpose",
            model: "sonnet",
            background: true,
            state: "running",
            started: now - 5 * Min,
        },
        {
            id: "b",
            description: "List the PRs",
            kind: "Explore",
            state: "done",
            started: now - 9 * Min,
            ended: now - 8 * Min,
        },
        { id: "c", description: "Check the links", kind: "general-purpose", state: "running", started: now - 1 * Min },
        { id: "d", description: "Broken", state: "failed", started: now - 7 * Min },
    ],
    activity: { tool: "Bash", target: "Build the docs site", at: now - 10_000 },
};

describe("recent topics", () => {
    it("reads the ticket from the workflow's branch names only", () => {
        expect(branchTicket("feature/555-companion-recap")).toBe("#555");
        expect(branchTicket("fix/12")).toBe("#12");
        expect(branchTicket("main")).toBe("");
        expect(branchTicket("feature/v2-thing")).toBe("");
        expect(branchTicket(undefined)).toBe("");
    });

    it("shows each topic as typed, with the facts of its work", () => {
        const rows = topicRows(view.topics, now);
        expect(rows.map((r) => r.text)).toEqual(["Write the release notes for 2.4", "Fix the checkout total"]);
        expect(rows[0].facts).toEqual(["#43", "1 file", "2 min ago"]);
        expect(rows[1].facts).toEqual(["2 files", "PR #812", "50 min ago"]);
        expect(rows[0].title).toContain("Branch: feature/43-release-notes");
    });

    it("renders the session's own name and the topics, newest first", () => {
        const html = renderToStaticMarkup(<RecentTopicsSection view={view} now={now} />);
        expect(html).toContain(">Checkout fixes and release notes<");
        expect(html.indexOf("Write the release notes for 2.4")).toBeLessThan(html.indexOf("Fix the checkout total"));
        expect(html).toContain("#43 · 1 file · 2 min ago");
    });

    it("says there is no topic yet rather than guessing one", () => {
        const html = renderToStaticMarkup(
            <RecentTopicsSection
                view={{ ...view, topics: undefined, session: { path: "/s", linkedby: "hook" } }}
                now={now}
            />
        );
        expect(html).toContain("No topic yet");
        expect(html).not.toContain('data-testid="companion-name"');
    });
});

describe("agents at work", () => {
    it("gives the main session its model and effort, its task and what it runs now", () => {
        const row = mainAgentRow(view, working);
        expect(row.name).toBe("Claude Code");
        expect(row.config).toBe("Opus · high");
        expect(row.stateLabel).toBe("working");
        expect(row.lines).toEqual(["Task: Write the release notes", "Now: Bash · Build the docs site"]);
    });

    it("names the topic when no task is in progress, and drops the current call once the agent stops", () => {
        const row = mainAgentRow({ ...view, todos: [] }, { ...working, state: "idle" });
        expect(row.lines).toEqual(["Topic: Write the release notes for 2.4"]);
        expect(mainAgentRow({ ...view, ended: true }, working)).toMatchObject({ state: "exited", config: "" });
    });

    it("lists the sub-agents that still run, newest first, and counts the others", () => {
        const agents = agentsView(view, working, now);
        expect(agents.rows.map((r) => r.name)).toEqual(["Claude Code", "Check the links", "Audit the docs"]);
        expect(agents.rows[2]).toMatchObject({ config: "Sonnet · high (inherited)", background: true });
        expect(agents.rows[1]).toMatchObject({ config: "Opus · high (inherited)" });
        expect(agents.rows[2].lines).toEqual(["general-purpose · background · started 5 min ago"]);
        expect(finishedLabel(agents.finished, agents.failed)).toBe("1 finished · 1 failed");
    });

    it("shows a foreground sub-agent only while its parent works, nothing once the agent exited", () => {
        const idle = agentsView(view, { ...working, state: "idle" }, now);
        expect(idle.rows.map((r) => r.name)).toEqual(["Claude Code", "Audit the docs"]);
        expect(agentsView({ ...view, ended: true }, working, now).rows).toHaveLength(1);
    });

    // #2294: the main session is not finished above sub-agents that work, as the Integration panel says.
    it("reads an idle or done main session as working while a background sub-agent runs, and as it is when none does", () => {
        for (const state of ["idle", "done"] as const) {
            const rows = agentsView(view, { ...working, state }, now).rows;
            expect(rows.map((r) => r.name)).toContain("Audit the docs");
            expect(rows[0]).toMatchObject({ main: true, state: "working" });
        }
        const none = agentsView({ ...view, subagents: [] }, { ...working, state: "done" }, now).rows;
        expect(none[0]).toMatchObject({ main: true, state: "done" });
        const exited = agentsView({ ...view, ended: true }, { ...working, state: "done" }, now).rows;
        expect(exited[0]).toMatchObject({ state: "exited" });
    });

    // #601: every row's model and effort, the ticket's complexity, and the hint when they are out of proportion.
    it("shows a sub-agent's own model and effort, and its ticket's complexity", () => {
        const sub = {
            id: "w",
            description: "#601 agents complexity",
            kind: "general-purpose",
            model: "claude-opus-5-5",
            effort: "high",
            branch: "feature/601-agents-complexity",
            ticket: 601,
            complexity: "low",
            background: true,
            state: "running" as const,
            started: now - Min,
        };
        const rows = agentsView({ ...view, subagents: [sub] }, working, now).rows;
        expect(rows[1]).toMatchObject({ config: "Opus 5.5 · high", ticket: "#601", complexity: "low" });
        expect(rows[1].hint?.kind).toBe("over");
        expect(rows[1].configTitle).toContain("Branch: feature/601-agents-complexity");
        const fits = agentsView({ ...view, subagents: [{ ...sub, complexity: "medium" }] }, working, now).rows;
        expect(fits[1].hint).toBeUndefined();
        const unlabelled = agentsView({ ...view, subagents: [{ ...sub, complexity: undefined }] }, working, now).rows;
        expect(unlabelled[1].ticket).toBeUndefined();
    });

    it("takes the main agent's model and effort from its transcript when the status line said nothing", () => {
        const session = {
            ...view.session,
            model: "claude-haiku-4-5",
            effort: "low",
            ticket: 42,
            complexity: "complex",
        };
        const bare: AgentStateInfo = { ...working, model: undefined, modelname: undefined, effort: undefined };
        const row = mainAgentRow({ ...view, session }, bare);
        expect(row.config).toBe("Haiku 4.5 · low");
        expect(row).toMatchObject({ ticket: "#42", complexity: "complex" });
        expect(row.hint?.kind).toBe("under");
        expect(mainAgentRow({ ...view, session }, working).config).toBe("Opus · high");
    });

    it("shows the main agent's ticket, its complexity and the hint in the hero (#2441)", () => {
        const session = { ...view.session, ticket: 7, complexity: "low" };
        const noop = () => {};
        const html = renderToStaticMarkup(
            <CompanionHero
                view={{ ...view, session, subagents: [] }}
                agentState={working}
                provider=""
                arranging={false}
                onArrange={noop}
                onLeaveArranging={noop}
                integrationDetails={false}
                persistentIntegration={false}
                onIntegration={noop}
                onHistory={noop}
                onBackToCurrent={noop}
            />
        );
        expect(html).toContain("#7 · complexity: low");
        expect(html).toContain('data-proportion="over"');
        expect(html).toContain("More than a low ticket needs");
        expect(html).toContain('data-testid="companion-model-effort">Opus · high<');
        // The AI sparkle names the main agent; the robot stays for the sub-agents.
        expect(html).toContain("fa-sparkles");
        expect(html).toContain("Main agent");
        // The plan beside the identity shows the step in progress: no "Task:" line repeats it (#2441).
        expect(html).toContain('data-testid="companion-plan"');
        expect(html).not.toContain("Task: ");
        // The tools say "Hooked up" in a word only when MoltenTerm hooked the run; none here.
        expect(html).not.toContain('data-testid="companion-integrated"');
    });

    it("keeps the way to the usage page in the hero while the usage block is hidden or not drawn (#2441)", () => {
        const noop = () => {};
        const withUsage: CompanionView = {
            ...view,
            usage: { pageurl: "https://claude.ai/settings/usage", pagename: "Claude usage" },
        };
        const hero = (usageBlockShown: boolean) =>
            renderToStaticMarkup(
                <CompanionHero
                    view={withUsage}
                    agentState={working}
                    provider=""
                    arranging={false}
                    onArrange={noop}
                    onLeaveArranging={noop}
                    integrationDetails={false}
                    persistentIntegration={false}
                    onIntegration={noop}
                    onHistory={noop}
                    onBackToCurrent={noop}
                    usageBlockShown={usageBlockShown}
                />
            );
        expect(hero(false)).toContain('data-testid="companion-usage"');
        expect(hero(true)).not.toContain('data-testid="companion-usage"');
    });

    it("keeps the task line when there is no plan to show the step, and says Hooked up in a word (#2441)", () => {
        const noop = () => {};
        const plain = { ...view, todos: [], topics: [] };
        const html = renderToStaticMarkup(
            <CompanionHero
                view={plain}
                agentState={working}
                provider=""
                arranging={false}
                onArrange={noop}
                onLeaveArranging={noop}
                integrationDetails={true}
                persistentIntegration={false}
                onIntegration={noop}
                onHistory={noop}
                onBackToCurrent={noop}
            />
        );
        expect(html).not.toContain('data-testid="companion-plan"');
        expect(html).toMatch(/aria-label="Hooked up by MoltenTerm"[^>]*data-testid="companion-integrated"/);
        expect(html).toMatch(/fa-plug[^<]*<\/i>Hooked up<\/button>/);
    });
});

const files: CompanionFile[] = [
    { path: "/w/src/emails/receipt.tsx", kind: "update", added: 3, removed: 1, edits: 1 },
    { path: "/w/src/checkout.ts", kind: "update", added: 12, removed: 5, edits: 2 },
    { path: "/w/CHANGELOG.md", kind: "add", added: 24, removed: 0, edits: 1 },
    { path: "/w/src/cart/checkout-button.tsx", kind: "update", added: 1, removed: 1, edits: 1 },
];

describe("changed files", () => {
    it("filters by path and name, a name match first, letters in order", () => {
        expect(filterFiles(files, "", "/w").map((f) => f.path)).toEqual(files.map((f) => f.path));
        expect(filterFiles(files, "checkout", "/w").map((f) => f.path)).toEqual([
            "/w/src/checkout.ts",
            "/w/src/cart/checkout-button.tsx",
        ]);
        expect(filterFiles(files, "emails", "/w").map((f) => f.path)).toEqual(["/w/src/emails/receipt.tsx"]);
        expect(filterFiles(files, "rcpt", "/w").map((f) => f.path)).toEqual(["/w/src/emails/receipt.tsx"]);
        expect(filterFiles(files, "zzz", "/w")).toEqual([]);
        expect(fuzzyScore("a/b.ts", "B.TS")).toBeGreaterThan(fuzzyScore("a/b.ts", "a/b"));
    });

    it("reads only the choices it knows from the client's meta", () => {
        expect(readCompanionPrefs(null)).toEqual({});
        expect(readCompanionPrefs({ filesopen: true, other: 1 })).toEqual({
            filesopen: true,
            usagedetails: false,
            summariesasked: false,
        });
        expect(readCompanionPrefs([true])).toEqual({});
    });

    const outside: CompanionFile[] = [
        ...files,
        { path: "/home/dev/.config/lantern/settings.json", kind: "update", added: 3, removed: 1, edits: 1 },
        { path: "/tmp/lantern-fixture/seed.json", kind: "add", added: 40, removed: 0, edits: 1 },
    ];

    it("shows paths relative to the project, the files outside it grouped last, from ~ under the home folder (#2441)", () => {
        const groups = fileGroups(outside, "/w", "/home/dev");
        expect(groups.inside.map((f) => f.dir + f.name)).toEqual([
            "src/emails/receipt.tsx",
            "src/checkout.ts",
            "CHANGELOG.md",
            "src/cart/checkout-button.tsx",
        ]);
        expect(groups.inside[0]).toMatchObject({ dir: "src/emails/", name: "receipt.tsx", outside: false });
        expect(groups.outside.map((f) => f.dir + f.name)).toEqual([
            "~/.config/lantern/settings.json",
            "/tmp/lantern-fixture/seed.json",
        ]);
    });

    it("draws the files in their block: relative paths, the outside group tagged, the filter in the tools", () => {
        let tools: React.ReactNode = null;
        const html = renderToStaticMarkup(
            <FilesSection
                target="t1"
                companionId="c1"
                files={outside}
                folder="/w"
                home="/home/dev"
                frame={(parts) => {
                    tools = parts.tools;
                    return <div data-count={parts.count}>{parts.body}</div>;
                }}
            />
        );
        expect(html).toContain('data-count="6"');
        expect(html).toContain(">src/emails/<");
        expect(html).not.toContain("/w/src");
        expect(html).toContain("Outside the project");
        expect(html.match(/>outside</g)).toHaveLength(2);
        expect(html).toContain(">~/.config/lantern/<");
        expect(renderToStaticMarkup(<>{tools}</>)).toContain('data-testid="companion-files-toggle"');
    });

    it("lists six files of the project, then Show all", () => {
        const many: CompanionFile[] = Array.from({ length: 9 }, (_, i) => ({
            path: `/w/src/f${i}.ts`,
            kind: "update",
            added: 1,
            removed: 0,
            edits: 1,
        }));
        const html = renderToStaticMarkup(
            <FilesSection target="t1" companionId="c1" files={many} folder="/w" frame={(p) => <>{p.body}</>} />
        );
        expect(html.match(/data-testid="companion-file"/g)).toHaveLength(FilesShown);
        expect(html).toContain("Show all (9 in the project)");
    });
});

describe("recent topics in their block (#2441)", () => {
    it("shows four topics, then Show N more", () => {
        const topics = Array.from({ length: 6 }, (_, i) => ({ text: `Topic ${i}`, last: now - i * Min }));
        const html = renderToStaticMarkup(<RecentTopicsSection view={{ ...view, topics }} now={now} />);
        expect(html.match(/data-testid="companion-topic"/g)).toHaveLength(4);
        expect(html).toContain("Show 2 more");
    });
});
