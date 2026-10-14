// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));

import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    cleanupNeedsConfirmation,
    cleanupPrDetail,
    cleanupStepDetail,
    cleanupStepLabel,
    cleanupSummary,
    confirmAgentWorktree,
    ReviewCleanupResult,
    ReviewCleanupSteps,
} from "./review-cleanup";

const risk = { sha: "a".repeat(40), changecount: 1, unpushed: 0, ignoredfilecount: 0 };

const result: ReviewCleanupResult = {
    repo: "acme/app",
    number: 7,
    ticket: 7,
    steps: [
        { id: "pr", state: "done", message: "PR #7 is merged into develop" },
        { id: "ticket-close", state: "failed", message: "gh issue close 7: HTTP 502" },
        { id: "ticket-done", state: "done" },
        {
            id: "agent-worktree",
            state: "skipped",
            reason: "the agent worktree holds 1 uncommitted change(s)",
            confirm: risk,
        },
        { id: "local-branch", state: "skipped", reason: "feature/7-thing is checked out in the kept agent worktree" },
        {
            id: "other-prs",
            state: "done",
            prs: [
                {
                    number: 8,
                    branch: "feature/8",
                    state: "skipped",
                    flag: "agent-busy",
                    reason: "update after the agent finishes",
                },
                { number: 9, branch: "feature/9", state: "done" },
            ],
        },
    ],
    startedat: 1,
    endedat: 2,
};

describe("review cleanup", () => {
    it("labels every step", () => {
        for (const id of ReviewCleanupSteps) {
            expect(cleanupStepLabel(id)).not.toBe(id);
        }
    });

    it("details a step by its state", () => {
        expect(cleanupStepDetail(result.steps[1])).toBe("gh issue close 7: HTTP 502");
        expect(cleanupStepDetail(result.steps[3])).toContain("uncommitted");
        expect(cleanupPrDetail(result.steps[5].prs[0])).toBe("update after the agent finishes");
        expect(cleanupPrDetail(result.steps[5].prs[1])).toBe("rebased by GitHub");
    });

    it("finds the agent worktree waiting for its confirmation", () => {
        expect(cleanupNeedsConfirmation(result)?.confirm).toEqual(risk);
        const removed = { ...result, steps: [{ id: "agent-worktree" as const, state: "done" as const }] };
        expect(cleanupNeedsConfirmation(removed)).toBeNull();
        expect(cleanupNeedsConfirmation(null)).toBeNull();
    });

    it("counts the steps by state", () => {
        expect(cleanupSummary(result)).toEqual({ done: 3, skipped: 2, failed: 1 });
    });

    it("confirms the worktree with the branch that depends on it", async () => {
        await confirmAgentWorktree({ dir: "/p", repo: "acme/app", number: 7 }, risk);
        expect(TabRpcClient.wshRpcCall).toHaveBeenCalledWith(
            "moltenreviewcleanup",
            {
                dir: "/p",
                repo: "acme/app",
                number: 7,
                steps: ["agent-worktree", "local-branch"],
                worktreeconfirmed: risk,
            },
            expect.objectContaining({ route: "molten:review" })
        );
    });
});
