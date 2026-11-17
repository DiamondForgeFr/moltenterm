// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What waits for the developer across the workspace's projects (FR-SHELL-087, #2174): the rail's badge, the sidebar's
// dots and the project chips count every project, not only the current one, so a pull request waiting in another
// project is never invisible. The pure sums, apart from the hooks that read each project's answer.

import { emptyPrCounts, PrCountKinds, type PrCounts } from "../sidebar/pr-counts-model";
import type { CardState } from "./reviews-card-model";
import type { ReviewCounts, ReviewPr } from "./reviews-model";
import { waitsForYou } from "./reviews-owners-model";

// Where, in another project than the one shown, pull requests the view's filter hides wait for the developer.
export type ElsewhereWaits = { projectId: string; label: string; count: number };

// workspaceProjectDirs: the repository of each project that has a folder, each once, in the workspace's order; a
// workspace without a list of projects follows its one project.
export function workspaceProjectDirs(
    projects: readonly { dir: string; repo?: string }[],
    repoOf: (project: { dir: string; repo?: string }) => string,
    fallback: string
): string[] {
    const rtn: string[] = [];
    for (const project of projects) {
        const dir = project.dir === "" ? "" : repoOf(project);
        if (dir !== "" && !rtn.includes(dir)) {
            rtn.push(dir);
        }
    }
    if (rtn.length === 0 && fallback) {
        rtn.push(fallback);
    }
    return rtn;
}

export function sumReviewCounts(list: readonly ReviewCounts[]): ReviewCounts {
    const rtn: ReviewCounts = { toreview: 0, mergeable: 0, drafts: 0 };
    for (const c of list) {
        rtn.toreview += c?.toreview ?? 0;
        rtn.mergeable += c?.mergeable ?? 0;
        rtn.drafts += c?.drafts ?? 0;
    }
    return rtn;
}

export function sumPrCounts(list: readonly PrCounts[]): PrCounts {
    const rtn = emptyPrCounts();
    for (const c of list) {
        for (const kind of PrCountKinds) {
            rtn[kind] += c?.[kind] ?? 0;
        }
    }
    return rtn;
}

// waitingOnYou: how many of the pull requests wait for the developer: their card's turn is "yours" (stuck until they
// act) or "ready" (they can merge it now). A chip shows it for its project.
export function waitingOnYou(prs: readonly ReviewPr[], cards: Record<number, CardState>): number {
    return prs.filter((pr) => waitsForYou(cards?.[pr.number])).length;
}
