// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2397: an Upcoming row names the sub-agent at work on its ticket. Synthetic agents and tickets only.

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { upcomingState } from "./reviews-upcoming";
import { branchAgent, type BranchAgent, type UpcomingAnswer, type UpcomingBranch } from "./reviews-upcoming-model";

const Row: UpcomingBranch = { branch: "fix/9301-sample", ticket: 9301, ahead: 2, title: "Sample", status: "In progress" };

function sub(branch: string, description: string, state: BranchAgent["state"] = "running"): BranchAgent {
    return {
        branch,
        worktree: "/p/.claude/worktrees/agent-c78f",
        kind: "subagent",
        agent: "claude",
        parentblockid: "lead",
        parentfirstname: "Flore",
        state,
        description,
        activeat: 1,
        agentid: "c78f",
    };
}

function upcoming(agents: BranchAgent[]): UpcomingAnswer {
    return { dir: "/p", target: "develop", branches: [Row], agents, at: 1 };
}

describe("an Upcoming row and the sub-agent at work on its ticket (#2397)", () => {
    it("names the sub-agent on the worktree's live branch", () => {
        const agent = branchAgent(upcoming([sub("fix/9301-sample", "#9301 sample")]), null, Row.branch);
        expect(upcomingState(t, Row, agent).sentence).toBe("A sub-agent of Flore is on it");
    });

    it("names one whose worktree branch has no ticket yet by the ticket its task names", () => {
        const agent = branchAgent(upcoming([sub("worktree-agent-c78f", "#9301 sample")]), null, Row.branch);
        expect(agent?.kind).toBe("subagent");
        expect(upcomingState(t, Row, agent).sentence).toBe("A sub-agent of Flore is on it");
    });

    it("never takes one on another ticket's branch, one naming other work, or a finished one", () => {
        for (const other of [
            sub("fix/9302-other", "#9301 follow-up"),
            sub("worktree-agent-c78f", "#9302 other work"),
            sub("worktree-agent-c78f", "#9301 sample", "done"),
            { ...sub("worktree-agent-c78f", "#9301 sample"), worktree: "" },
        ]) {
            const agent = branchAgent(upcoming([other]), null, Row.branch);
            expect(upcomingState(t, Row, agent).sentence).toBe("Nobody on it");
        }
    });
});
