// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity indicator and the Integration panel read the same sub-agents (FR-BOSS-009, AC85, #2294): whatever the panel
// shows at work, the indicator counts, and whatever it shows stopped, the indicator does not. Synthetic agent states only.

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { branchAgents, type BranchAgent, type UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import { runningSubagents } from "./activity-model";

const Dir = "/work/product";

const Lead: AgentStateInfo = {
    blockid: "lead",
    tabid: "t1",
    workspaceid: "ws-1",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Flore",
    state: "idle",
    version: 1,
};

const States: AgentStatesData = { states: { lead: Lead }, versions: {} };

function sub(state: string, more: Partial<BranchAgent> = {}): BranchAgent {
    return {
        branch: "",
        worktree: "",
        kind: "subagent",
        agent: "claude",
        parentblockid: "lead",
        parentfirstname: "Flore",
        state: state as BranchAgent["state"],
        agentid: `${state}-${more.branch ?? "unplaced"}`,
        ...more,
    };
}

const Branches = ["fix/1-placed", "fix/2-quiet", "fix/3-done", "fix/4-unplaced", "fix/5-unnamed"];

function panelRunning(answer: UpcomingAnswer): number {
    return Branches.flatMap((branch) => branchAgents(answer, States, branch)).filter(
        (facts) => facts.kind === "subagent" && facts.subState === "running"
    ).length;
}

function answerOf(agents: BranchAgent[]): UpcomingAnswer {
    return { dir: Dir, target: "develop", branches: [], agents, at: 1 };
}

describe("the sub-agents the panel shows at work are the ones the indicator counts (#2294)", () => {
    // A sub-agent in no worktree is the branch's only when its lead already works there (#2297): the lead's panel is on
    // the fourth branch.
    const leadPanel: BranchAgent = { branch: "fix/4-unplaced", worktree: "/w/4", kind: "panel", blockid: "lead" };
    const agents = [
        sub("running", { branch: "fix/1-placed", worktree: "/w/1", description: "#1 placed" }),
        sub("quiet", { branch: "fix/2-quiet", worktree: "/w/2", description: "#2 quiet" }),
        sub("done", { branch: "fix/3-done", worktree: "/w/3", description: "#3 done" }),
        leadPanel,
        sub("running", { description: "#4 reads the ticket" }),
    ];

    it("counts the placed and the unplaced running ones, and neither the quiet nor the finished", () => {
        const answer = answerOf(agents);
        const counted = runningSubagents({ [Dir]: answer }, [Dir], States.states, "ws-1").get("lead");
        expect(panelRunning(answer)).toBe(2);
        expect(counted).toBe(2);
    });

    it("counts a state wavesrv does not name as the panel shows it: at work", () => {
        const answer = answerOf([sub("", { branch: "fix/1-placed", worktree: "/w/1", description: "#1" })]);
        expect(panelRunning(answer)).toBe(1);
        expect(runningSubagents({ [Dir]: answer }, [Dir], States.states, "ws-1").get("lead")).toBe(1);
    });

    it("counts none when the panel shows none at work", () => {
        const answer = answerOf(agents.filter((a) => a.state !== "running"));
        expect(panelRunning(answer)).toBe(0);
        expect(runningSubagents({ [Dir]: answer }, [Dir], States.states, "ws-1").size).toBe(0);
    });

    it("counts a running sub-agent the panel ties to no ticket as well: the indicator says it runs, the panel lists it by its task", () => {
        const answer = answerOf([sub("running", { description: "read the logs" })]);
        expect(panelRunning(answer)).toBe(0);
        expect(runningSubagents({ [Dir]: answer }, [Dir], States.states, "ws-1").get("lead")).toBe(1);
    });
});
