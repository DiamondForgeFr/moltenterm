// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentStatesData } from "../agent-state-model";
import { t } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import {
    aheadText,
    barTimeText,
    BoardStatusKeys,
    boardStatusText,
    branchAgent,
    DraftActiveMs,
    draftTurn,
    durationText,
    prOtherBranches,
    subagentDetails,
    UpcomingAnswer,
    upcomingFocusBranch,
    upcomingRows,
} from "./reviews-upcoming-model";

const Now = new Date(2026, 9, 15, 20, 53).getTime();

function answer(extra: Partial<UpcomingAnswer> = {}): UpcomingAnswer {
    return { dir: "/p", branches: [], agents: [], at: Now, ...extra };
}

function states(infos: Record<string, Partial<AgentStatesData["states"][string]>>): AgentStatesData {
    const rtn: AgentStatesData = { states: {}, versions: {} };
    for (const [blockid, info] of Object.entries(infos)) {
        rtn.states[blockid] = { blockid, version: 1, ...info };
        rtn.versions[blockid] = 1;
    }
    return rtn;
}

describe("upcomingRows (#712 AC1)", () => {
    it("drops a branch as soon as the Reviews list shows its PR", () => {
        const upcoming = answer({
            branches: [
                { branch: "feature/1-a", ticket: 1, ahead: 2 },
                { branch: "feature/2-b", ticket: 2, ahead: 1 },
            ],
        });
        const reviews = { dir: "/p", ready: [], drafts: [{ branch: "feature/2-b" } as ReviewPr] } as ReviewsAnswer;
        expect(upcomingRows(upcoming, reviews).map((b) => b.branch)).toEqual(["feature/1-a"]);
        expect(upcomingRows(null, reviews)).toEqual([]);
    });

    // #1172: the gold showed #1163 twice, its draft PR #1169 in Yours and its local test copy test/1163-local in
    // Upcoming.
    it("shows one card per ticket: another branch of a listed PR's ticket is on that PR's card", () => {
        const draft = { number: 1169, branch: "feature/1163-pipeline-setup-agent", ticket: 1163 } as ReviewPr;
        const upcoming = answer({
            branches: [
                { branch: "test/1163-local", ticket: 1163, ahead: 11 },
                { branch: "feature/1170-next", ticket: 1170, ahead: 1 },
            ],
            prbranches: [
                {
                    branch: "test/1163-copy",
                    ticket: 1163,
                    pr: 1169,
                    ahead: 2,
                    worktree: "/p/.claude/worktrees/agent-1",
                },
                { branch: "fix/12-other", ticket: 12, pr: 13, ahead: 1 },
            ],
        });
        const reviews = { dir: "/p", ready: [], drafts: [draft] } as ReviewsAnswer;
        expect(upcomingRows(upcoming, reviews).map((b) => b.branch)).toEqual(["feature/1170-next"]);
        expect(prOtherBranches(upcoming, draft).map((b) => [b.branch, b.pr, b.ahead])).toEqual([
            ["test/1163-copy", 1169, 2],
            ["test/1163-local", 1169, 11],
        ]);
        expect(prOtherBranches(upcoming, { number: 7, branch: "feature/7-x" })).toEqual([]);
        expect(prOtherBranches(null, draft)).toEqual([]);
    });
});

describe("upcomingFocusBranch (#962)", () => {
    const rows = [{ branch: "feature/109-loader", ticket: 109, ahead: 1 }];

    it("answers a future PR's focus for this project once its entry is listed", () => {
        expect(upcomingFocusBranch({ dir: "/p", number: 0, branch: "feature/109-loader" }, "/p", rows)).toBe(
            "feature/109-loader"
        );
        expect(upcomingFocusBranch({ dir: "/p", number: 0, branch: "feature/109-loader" }, "/p", [])).toBeNull();
    });

    it("leaves a PR's focus, another project's and an empty one to others", () => {
        expect(upcomingFocusBranch({ dir: "/p", number: 110 }, "/p", rows)).toBeNull();
        expect(upcomingFocusBranch({ dir: "/q", number: 0, branch: "feature/109-loader" }, "/p", rows)).toBeNull();
        expect(upcomingFocusBranch(null, "/p", rows)).toBeNull();
    });
});

describe("branchAgent (#712 AC2, AC4)", () => {
    const upcoming = answer({
        agents: [
            {
                branch: "feature/1-a",
                worktree: "/w/a",
                kind: "panel",
                blockid: "b1",
                agent: "claude",
                started: Now - 12 * 60_000,
            },
            {
                branch: "feature/1-a",
                worktree: "/w/a",
                kind: "panel",
                blockid: "b2",
                agent: "codex",
                started: Now - 60_000,
            },
            {
                branch: "feature/2-b",
                worktree: "/w/b",
                kind: "background",
                agent: "claude",
                activeat: Now - 3 * 60_000,
                parentblockid: "b9",
            },
            { branch: "feature/3-c", worktree: "/w/c", kind: "panel", blockid: "gone" },
        ],
    });

    it("reads the live state and first name, the most urgent panel first", () => {
        const live = states({
            b1: { agent: "claude", firstname: "Valentin", state: "working" },
            b2: { agent: "codex", firstname: "Jérôme", state: "waiting" },
        });
        expect(branchAgent(upcoming, live, "feature/1-a")).toMatchObject({
            kind: "panel",
            blockId: "b2",
            name: "Jérôme",
            state: "waiting",
        });
        const working = states({
            b1: { agent: "claude", firstname: "Valentin", state: "working" },
            b2: { agent: "codex", state: "idle" },
        });
        expect(branchAgent(upcoming, working, "feature/1-a")).toMatchObject({
            blockId: "b1",
            name: "Valentin",
            state: "working",
            since: Now - 12 * 60_000,
        });
    });

    it("carries what MoltenTerm says the agent does while it holds its state (#896)", () => {
        const live = states({
            b1: {
                agent: "claude",
                firstname: "Valentin",
                state: "working",
                message: "Fixing the CI of #12",
                messagetext: { code: "agentHold.fixing", vars: { number: "12" } },
            },
        });
        expect(branchAgent(upcoming, live, "feature/1-a")).toMatchObject({
            name: "Valentin",
            state: "working",
            held: { text: { code: "agentHold.fixing" }, english: "Fixing the CI of #12" },
        });
        const own = states({ b1: { agent: "claude", state: "working", message: "Bash" } });
        expect(branchAgent(upcoming, own, "feature/1-a").held).toBeUndefined();
    });

    it("names a background agent's parent from the live states", () => {
        const live = states({ b9: { agent: "claude", firstname: "Valentin" } });
        expect(branchAgent(upcoming, live, "feature/2-b")).toMatchObject({
            kind: "background",
            state: "background",
            parentBlockId: "b9",
            parentName: "Valentin",
        });
    });

    it("shows nothing for a closed panel or a branch without agent", () => {
        expect(branchAgent(upcoming, states({}), "feature/3-c")).toBeNull();
        expect(branchAgent(upcoming, states({}), "feature/9-z")).toBeNull();
        expect(branchAgent(null, states({}), "feature/1-a")).toBeNull();
    });
});

describe("sub-agents on the upcoming rows (#1035)", () => {
    const upcoming = answer({
        agents: [
            {
                branch: "feature/1033-tabs",
                worktree: "/p/.claude/worktrees/agent-a",
                kind: "subagent",
                agent: "claude",
                activeat: Now - 2 * 60_000,
                parentblockid: "b9",
                parentfirstname: "Val",
                model: "claude-opus-5-5",
                description: "#1033 agent name in tabs",
                state: "running",
            },
            {
                branch: "feature/1029-notes",
                worktree: "/p/.claude/worktrees/agent-b",
                kind: "subagent",
                agent: "codex",
                activeat: Now - 12 * 60_000,
                parentblockid: "b8",
                model: "gpt-6-astra",
                description: "audit reliability",
                state: "done",
            },
            { branch: "feature/1029-notes", worktree: "/w/x", kind: "background", activeat: Now },
        ],
    });
    const live = states({
        b9: { agent: "claude", agentname: "Claude Code", firstname: "Valentin" },
        b8: { agent: "codex", firstname: "Jérôme" },
    });

    it("names a running sub-agent by its parent, tool, model and task", () => {
        const facts = branchAgent(upcoming, live, "feature/1033-tabs");
        expect(facts).toMatchObject({
            kind: "subagent",
            state: "working",
            subState: "running",
            parentBlockId: "b9",
            parentName: "Valentin",
        });
        expect(subagentDetails(facts)).toBe("Claude Code · Opus 5.5 · #1033 agent name in tabs");
        expect(barTimeText(t, facts, Now)).toBe("last change 2 min ago");
    });

    it("says a finished sub-agent is done and since when, over a background guess", () => {
        const facts = branchAgent(upcoming, live, "feature/1029-notes");
        expect(facts).toMatchObject({ kind: "subagent", state: "done", subState: "done", parentName: "Jérôme" });
        expect(subagentDetails(facts)).toBe("Codex · gpt-6-astra · audit reliability");
        expect(barTimeText(t, facts, Now)).toBe("finished 12 min ago");
        expect(translate("fr", "reviewsAgents.subagent.finishedAgo", { duration: "12 min" })).toBe(
            "terminé il y a 12 min"
        );
    });

    it("lets a panel on the branch win over a sub-agent", () => {
        const both = answer({
            agents: [
                { ...upcoming.agents[0] },
                { branch: "feature/1033-tabs", worktree: "/w", kind: "panel", blockid: "b1", started: Now },
            ],
        });
        const facts = branchAgent(
            both,
            states({ b1: { agent: "claude", firstname: "Bruno", state: "idle" } }),
            "feature/1033-tabs"
        );
        expect(facts).toMatchObject({ kind: "panel", name: "Bruno" });
    });
});

describe("draftTurn (#712 AC3, #954)", () => {
    const Now = 10 * 3600_000;
    const old = Now - 5 * 3600_000;

    it("never gives the developer a draft an agent works on", () => {
        const agent = { kind: "panel" as const, name: "V", state: "working" as const, since: 1 };
        expect(draftTurn(agent, { branch: "b", status: "Human Testing", commitat: old }, Now).owner).toBe("agent");
    });

    it("follows the workflow's board column: AI Testing is the agent's on a Solo workflow", () => {
        expect(draftTurn(null, { branch: "b", status: "AI Testing", commitat: old }, Now)).toMatchObject({
            owner: "agent",
            kind: "agent",
        });
        expect(draftTurn(null, { branch: "b", status: "In progress", commitat: old }, Now).owner).toBe("agent");
        expect(draftTurn(null, { branch: "b", status: "Human Testing", commitat: old }, Now)).toMatchObject({
            owner: "developer",
            kind: "test",
        });
        expect(draftTurn(null, { branch: "b", status: "In Review", commitat: old }, Now).kind).toBe("ready");
    });

    it("reads a recent commit as an agent at work, even one started outside MoltenTerm", () => {
        expect(draftTurn(null, { branch: "b", commitat: Now - DraftActiveMs / 2 }, Now).owner).toBe("agent");
        expect(draftTurn(null, { branch: "b", commitat: old }, Now)).toMatchObject({
            owner: "developer",
            kind: "yours",
        });
        expect(draftTurn(null, null, Now).kind).toBe("yours");
    });
});

describe("the bar's time line", () => {
    it("says how long and since when, at minute granularity", () => {
        expect(durationText(t, 30_000)).toBe("less than a minute");
        expect(durationText(t, 12 * 60_000 + 59_000)).toBe("12 min");
        expect(durationText(t, 125 * 60_000)).toBe("2 h 05");
        expect(durationText(t, 50 * 3_600_000)).toBe("2 d");
        const since = new Date(2026, 9, 15, 20, 41).getTime();
        expect(barTimeText(t, { kind: "panel", name: "V", state: "working", since }, Now)).toBe(
            "for 12 min · since 20:41"
        );
        expect(
            barTimeText(t, { kind: "background", name: "", state: "background", since: Now - 3 * 60_000 }, Now)
        ).toBe("last change 3 min ago");
        expect(barTimeText(t, { kind: "panel", name: "V", state: "working", since: 0 }, Now)).toBe("");
    });

    it("counts commits ahead", () => {
        expect(aheadText(t, 0)).toBe("no commit yet");
        expect(aheadText(t, 1)).toBe("1 commit ahead");
        expect(aheadText(t, 3)).toBe("3 commits ahead");
    });
});

describe("boardStatusText (#727)", () => {
    const fr = (key: string, vars?: Record<string, any>) => translate("fr", key, vars);

    it("translates the workflow's statuses, whatever their case", () => {
        expect(boardStatusText(fr, "In progress")).toBe("En cours");
        expect(boardStatusText(fr, "In Progress")).toBe("En cours");
        expect(boardStatusText(fr, "AI Testing")).toBe("Tests IA");
        expect(boardStatusText(fr, "In Review")).toBe("En revue");
        expect(boardStatusText(t, "AI Testing")).toBe("AI testing");
    });

    it("shows a column the workflow does not declare as the board names it", () => {
        expect(boardStatusText(fr, "Blocked by legal")).toBe("Blocked by legal");
        expect(boardStatusText(fr, "constructor")).toBe("constructor");
    });

    it("has a key in both languages for each status", () => {
        for (const key of Object.values(BoardStatusKeys)) {
            expect(translate("fr", key)).not.toBe(key);
            expect(translate("en", key)).not.toBe(key);
        }
    });
});
