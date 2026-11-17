// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-SHELL-087 (#2174): the rail badge, the sidebar dots and the project chips count every project of the workspace.

import { describe, expect, it } from "vitest";
import type { CardState } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import { sumPrCounts, sumReviewCounts, waitingOnYou, workspaceProjectDirs } from "./reviews-workspace-model";

const repoOf = (p: { dir: string; repo?: string }) => p.repo || p.dir;

describe("the projects a workspace counts", () => {
    it("are the repository of each project with a folder, each once, in order", () => {
        const dirs = workspaceProjectDirs(
            [{ dir: "/w/desktop" }, { dir: "/w/mobile", repo: "/w/mobile/app" }, { dir: "" }, { dir: "/w/desktop" }],
            repoOf,
            "/w/desktop"
        );
        expect(dirs).toEqual(["/w/desktop", "/w/mobile/app"]);
    });

    it("follow the one project of a workspace without a list", () => {
        expect(workspaceProjectDirs([], repoOf, "/w/only")).toEqual(["/w/only"]);
        expect(workspaceProjectDirs([], repoOf, "")).toEqual([]);
    });
});

describe("the sums over the projects", () => {
    it("adds up the rail's badge counts", () => {
        expect(
            sumReviewCounts([
                { toreview: 2, mergeable: 1, drafts: 0 },
                { toreview: 1, mergeable: 3, drafts: 4 },
                undefined,
            ])
        ).toEqual({ toreview: 3, mergeable: 4, drafts: 4 });
        expect(sumReviewCounts([])).toEqual({ toreview: 0, mergeable: 0, drafts: 0 });
    });

    it("adds up the sidebar's dots by section", () => {
        expect(
            sumPrCounts([
                { yours: 1, ready: 0, waiting: 2, agents: 0 },
                { yours: 0, ready: 3, waiting: 1, agents: 5 },
            ])
        ).toEqual({ yours: 1, ready: 3, waiting: 3, agents: 5 });
    });

    it("counts the pull requests of a project that wait for the developer: stuck on them, or ready to merge", () => {
        const prs = [1, 2, 3, 4].map((number) => ({ number }) as ReviewPr);
        const cards = {
            1: { turn: "yours" },
            2: { turn: "ready" },
            3: { turn: "waiting" },
            4: { turn: "agents" },
        } as unknown as Record<number, CardState>;
        expect(waitingOnYou(prs, cards)).toBe(2);
        expect(waitingOnYou(prs, {})).toBe(0);
        expect(waitingOnYou([], cards)).toBe(0);
    });
});
