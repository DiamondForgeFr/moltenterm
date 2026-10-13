// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentStateInfo } from "../agent-state-model";
import { FilesSection } from "./companion-files";
import { filterFiles, fuzzyScore, readCompanionPrefs } from "./companion-files-model";
import { CompanionFile, CompanionView } from "./companion-model";
import { AgentsSection, RecentTopicsSection } from "./companion-recap";
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
        expect(html).toContain("Recent topics");
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
        expect(agents.rows[2]).toMatchObject({ config: "sonnet", background: true });
        expect(agents.rows[2].lines).toEqual(["general-purpose · background · started 5 min ago"]);
        expect(finishedLabel(agents.finished, agents.failed)).toBe("1 finished · 1 failed");
    });

    it("shows a foreground sub-agent only while its parent works, nothing once the agent exited", () => {
        const idle = agentsView(view, { ...working, state: "idle" }, now);
        expect(idle.rows.map((r) => r.name)).toEqual(["Claude Code", "Audit the docs"]);
        expect(agentsView({ ...view, ended: true }, working, now).rows).toHaveLength(1);
    });

    it("renders the main session and its sub-agents", () => {
        const html = renderToStaticMarkup(<AgentsSection view={view} agentState={working} now={now} />);
        expect(html).toContain("Agents at work");
        expect(html).toContain('data-testid="companion-model-effort">Opus · high<');
        expect(html.match(/data-testid="companion-subagent"/g)).toHaveLength(2);
        expect(html).toContain("1 finished · 1 failed");
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
        expect(readCompanionPrefs({ filesopen: true, other: 1 })).toEqual({ filesopen: true, usagedetails: false });
        expect(readCompanionPrefs([true])).toEqual({});
    });

    it("is collapsed by default with its count, the list and the filter hidden", () => {
        const html = renderToStaticMarkup(<FilesSection target="t1" companionId="c1" files={files} folder="/w" />);
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('data-testid="companion-files-count">4<');
        expect(html).not.toContain('data-testid="companion-files-filter"');
        expect(html).not.toContain("CHANGELOG.md");
    });
});
