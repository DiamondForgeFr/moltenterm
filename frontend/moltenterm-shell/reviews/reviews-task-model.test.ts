// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { t } from "../i18n/i18n";
import type { ReviewPr } from "./reviews-model";
import {
    agentLines,
    checkAgentsPlan,
    checkReportText,
    prLeft,
    PrTask,
    prTaskState,
    StuckGraceMs,
    taskAgent,
    taskAgentLive,
    taskStateText,
} from "./reviews-task-model";
import { AgentBarFacts, branchAgents, UpcomingAnswer } from "./reviews-upcoming-model";

const Asked = 1_000_000;

function pr(over: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number: 102,
        title: "PR 102",
        url: "https://github.com/a/b/pull/102",
        branch: "feature/102-x",
        base: "develop",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
        ...over,
    };
}

const conflicted = pr({ merge: "conflicts" });
const red = pr({
    ci: { state: "failure", success: 0, failure: 1, pending: 0, checks: [{ name: "build", state: "failure" }] },
});

const rebase: PrTask = { kind: "rebase", name: "Bruno", blockId: "b1", head: "h", at: Asked };

function bruno(state: AgentBarFacts["state"], stateSince: number, over: Partial<AgentBarFacts> = {}): AgentBarFacts {
    return {
        kind: "panel",
        blockId: "b1",
        agent: "claude",
        name: "Bruno",
        state,
        since: Asked - 1,
        stateSince,
        ...over,
    };
}

function tCount(key: string, count: number): string {
    return t(`${key}.${count === 1 ? "one" : "other"}`, { count });
}

describe("prTaskState (#954 AC6)", () => {
    it("is done once the goal is reached", () => {
        expect(prTaskState(rebase, pr(), bruno("idle", Asked + 10), Asked + 20)).toBe("done");
        expect(prTaskState({ ...rebase, kind: "investigate" }, pr(), null, Asked + 20)).toBe("done");
    });

    it("runs while the agent works, waits for the developer, or the CI runs", () => {
        expect(prTaskState(rebase, conflicted, bruno("working", Asked + 10), Asked + StuckGraceMs * 5)).toBe("running");
        expect(prTaskState(rebase, conflicted, bruno("waiting", Asked + 10), Asked + StuckGraceMs * 5)).toBe("running");
        const ciRuns = pr({ ci: { state: "pending", success: 0, failure: 0, pending: 1, checks: [] } });
        expect(prTaskState({ ...rebase, kind: "investigate" }, ciRuns, null, Asked + StuckGraceMs * 5)).toBe("running");
    });

    it("is stuck when the agent went idle after the ask with the conflicts still there", () => {
        expect(prTaskState(rebase, conflicted, bruno("idle", Asked + 5 * 60_000), Asked + 5 * 60_000)).toBe("stuck");
        expect(prTaskState(rebase, conflicted, bruno("done", Asked + 60_000), Asked + 60_000)).toBe("stuck");
        expect(prTaskState(rebase, conflicted, bruno("waiting", Asked + 1, { errored: true }), Asked + 2)).toBe(
            "stuck"
        );
    });

    it("gives an idle agent that has not moved a moment to start, then calls it stuck", () => {
        const idleBefore = bruno("idle", Asked - 60_000);
        expect(prTaskState(rebase, conflicted, idleBefore, Asked + 10_000)).toBe("running");
        expect(prTaskState(rebase, conflicted, idleBefore, Asked + StuckGraceMs)).toBe("stuck");
    });

    it("is stuck when the agent's session is gone, after the grace", () => {
        expect(prTaskState(rebase, conflicted, null, Asked + 10_000)).toBe("running");
        expect(prTaskState(rebase, conflicted, null, Asked + StuckGraceMs)).toBe("stuck");
        const other = bruno("idle", Asked + 10, { blockId: "b2", name: "Rita" });
        expect(prTaskState(rebase, conflicted, other, Asked + StuckGraceMs)).toBe("stuck");
        const guess: AgentBarFacts = {
            kind: "background",
            agent: "claude",
            name: "",
            state: "background",
            since: Asked,
        };
        expect(prTaskState(rebase, conflicted, guess, Asked + StuckGraceMs)).toBe("stuck");
        expect(prTaskState({ ...rebase, blockId: "" }, conflicted, guess, Asked + StuckGraceMs)).toBe("running");
    });

    it("follows a check of the PR to done only when nothing is left but the report", () => {
        const finish: PrTask = { ...rebase, kind: "finish" };
        expect(prTaskState(finish, red, bruno("idle", Asked + 10), Asked + 20)).toBe("stuck");
        expect(prTaskState(finish, pr({ reviewdecision: "CHANGES_REQUESTED" }), null, Asked + StuckGraceMs)).toBe(
            "stuck"
        );
        expect(prTaskState(finish, pr({ report: { state: "missing" } }), null, Asked + StuckGraceMs)).toBe("done");
    });
});

describe("taskStateText (#954 AC6)", () => {
    it("says the agent stopped before finishing, and what remains", () => {
        expect(taskStateText(t, rebase, "stuck", true, conflicted)).toBe(
            "stopped before finishing the rebase: conflicts with develop remain"
        );
        expect(taskStateText(t, { ...rebase, kind: "investigate" }, "stuck", false, red)).toBe(
            "its session ended before finishing the resolution of what blocks it: the CI is still red"
        );
        expect(taskStateText(t, rebase, "done", true, pr())).toBe("rebase done, no conflict left");
        expect(taskStateText(t, rebase, "running", true, conflicted)).toBe("");
    });
});

describe("Check the agents (#954 AC8)", () => {
    it("keeps the PRs with something left and skips the others", () => {
        const prs = [
            pr({ number: 1 }),
            pr({ number: 2, merge: "conflicts" }),
            pr({ number: 3, report: { state: "missing" } }),
        ];
        const plan = checkAgentsPlan(prs);
        expect(plan.checked).toBe(3);
        expect(plan.needs.map((p) => p.number)).toEqual([2, 3]);
    });

    it("reads what is left from the list's facts", () => {
        expect(prLeft(red)).toEqual({
            conflicts: false,
            ciRed: true,
            failedChecks: ["build"],
            changesRequested: false,
            noReport: false,
        });
        expect(prLeft(pr({ ci: { state: "failure", success: 0, failure: 1, pending: 0, checks: [] } })).ciRed).toBe(
            true
        );
    });

    it("reports the count", () => {
        const text = checkReportText(tCount, {
            checked: 3,
            needs: 1,
            sent: 1,
            busy: 0,
            offers: [],
            started: 0,
            failed: 0,
        });
        expect(text).toBe("3 checked, 1 needs work · 1 sent to its agent");
    });
});

describe("a task on a branch shared by two agents (#1057)", () => {
    const branch = "feature/1106-handoff";
    const upcoming: UpcomingAnswer = {
        dir: "/p",
        branches: [],
        at: Asked,
        agents: [
            { branch, worktree: "/w/a", kind: "panel", blockid: "jeanne", agent: "claude", started: Asked - 60_000 },
            { branch, worktree: "/w/b", kind: "panel", blockid: "nathan", agent: "codex", started: Asked + 60_000 },
        ],
    };
    const live: AgentStatesData = {
        states: {
            jeanne: { blockid: "jeanne", version: 1, agent: "claude", firstname: "Jeanne", state: "idle", since: 1 },
            nathan: { blockid: "nathan", version: 1, agent: "codex", firstname: "Nathan", state: "working", since: 2 },
        },
        versions: { jeanne: 1, nathan: 1 },
    };
    const asked: PrTask = { kind: "rebase", name: "Jeanne", blockId: "jeanne", head: "h", at: Asked };
    const later = Asked + 14 * 60_000;

    it("judges the task against its own idle agent, not the working one, and never says its session ended", () => {
        const agents = branchAgents(upcoming, live, branch);
        expect(agents.map((a) => a.name)).toEqual(["Nathan", "Jeanne"]);
        const owner = taskAgent(asked, agents, live);
        expect(owner).toMatchObject({ blockId: "jeanne", name: "Jeanne", state: "idle" });
        const state = prTaskState(asked, conflicted, owner, later);
        expect(state).toBe("stuck");
        const text = taskStateText(t, asked, state, taskAgentLive(asked, owner), conflicted);
        expect(text).toBe("stopped before finishing the rebase: conflicts with develop remain");
        expect(text).not.toContain("session ended");
    });

    it("lists every agent of the branch, the task on its own agent's line", () => {
        const agents = branchAgents(upcoming, live, branch);
        const lines = agentLines(agents, asked, taskAgent(asked, agents, live));
        expect(lines.map((l) => [l.facts.name, l.facts.state, l.task])).toEqual([
            ["Nathan", "working", false],
            ["Jeanne", "idle", true],
        ]);
        expect(agentLines(agents, null, null).map((l) => l.task)).toEqual([false, false]);
    });

    it("keeps a task running while its own agent works, whoever else is idle", () => {
        const swapped: AgentStatesData = {
            ...live,
            states: {
                jeanne: { ...live.states.jeanne, state: "working", since: Asked + 1 },
                nathan: { ...live.states.nathan, state: "idle" },
            },
        };
        const agents = branchAgents(upcoming, swapped, branch);
        expect(prTaskState(asked, conflicted, taskAgent(asked, agents, swapped), later)).toBe("running");
    });

    it("says inactive, not ended, for a terminal still open off the branch; ended once it is closed", () => {
        const moved: UpcomingAnswer = { ...upcoming, agents: upcoming.agents.filter((a) => a.blockid !== "jeanne") };
        const agents = branchAgents(moved, live, branch);
        const owner = taskAgent(asked, agents, live);
        expect(owner).toMatchObject({ blockId: "jeanne", offBranch: true });
        expect(prTaskState(asked, conflicted, owner, Asked + 10_000)).toBe("running");
        expect(prTaskState(asked, conflicted, owner, later)).toBe("stuck");
        expect(taskAgentLive(asked, owner)).toBe(true);
        expect(agentLines(agents, asked, owner).map((l) => [l.facts.name, l.task])).toEqual([
            ["Nathan", false],
            ["Jeanne", true],
        ]);

        const closed: AgentStatesData = { states: { nathan: live.states.nathan }, versions: { nathan: 1 } };
        const gone = taskAgent(asked, branchAgents(moved, closed, branch), closed);
        expect(gone).toBeNull();
        expect(taskStateText(t, asked, prTaskState(asked, conflicted, gone, later), false, conflicted)).toContain(
            "its session ended"
        );
        expect(agentLines(branchAgents(moved, closed, branch), asked, gone).map((l) => l.task)).toEqual([false, true]);
    });

    it("falls back to the branch's first agent for a task that named no terminal", () => {
        const agents = branchAgents(upcoming, live, branch);
        expect(taskAgent({ ...asked, blockId: "" }, agents, live)?.name).toBe("Nathan");
        expect(taskAgent(null, agents, live)).toBeNull();
    });
});
