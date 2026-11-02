// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cleanupNeedsConfirmation, confirmAgentWorktree, ReviewCleanupStepResult } from "./review-cleanup";

const risk = { sha: "a".repeat(40), changecount: 1, unpushed: 0, ignoredfilecount: 0 };
const loss = { changes: ["b.txt"], changecount: 1, commits: [], commitcount: 0, ignored: [], ignoredcount: 0 };

describe("review cleanup", () => {
    it("finds the agent worktree kept for its work", () => {
        const kept: ReviewCleanupStepResult = {
            id: "agent-worktree",
            state: "skipped",
            code: "kept",
            loss,
            confirm: risk,
        };
        expect(cleanupNeedsConfirmation([kept])?.confirm).toEqual(risk);
        expect(cleanupNeedsConfirmation([{ id: "agent-worktree", state: "done" }])).toBeNull();
        expect(cleanupNeedsConfirmation([{ id: "agent-worktree", state: "planned", confirm: risk }])).toBeNull();
        expect(cleanupNeedsConfirmation(null)).toBeNull();
    });

    it("removes the worktree with the branch that depends on it", async () => {
        await confirmAgentWorktree({ dir: "/p", repo: "acme/app", number: 7 }, risk);
        expect(TabRpcClient.wshRpcCall).toHaveBeenCalledWith(
            "moltenreviewcleanup",
            {
                dir: "/p",
                repo: "acme/app",
                number: 7,
                steps: ["agent-worktree", "local-branch", "remote-branch"],
                worktreeconfirmed: risk,
            },
            expect.objectContaining({ route: "molten:review" })
        );
    });
});
