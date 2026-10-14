// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's entry points (FR-REV-001-AC3, DS-REV-012): the widget opens the view, Mission Control's Pull
// requests waiting block opens it on one PR, and a row opens that PR's Review tab (FR-REV-002).

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { openMoltentermView } from "../open-view";
import { openReviewTab } from "../review/review-client";
import { MoltentermReviewsView, repoOfPrUrl, ReviewPr } from "./reviews-model";

// The PR a Reviews view brings into sight and marks, asked by another surface.
export type ReviewsFocus = { dir: string; number: number; at: number };

export class ReviewsModel {
    private static instance: ReviewsModel = null;

    focusAtom = atom(null) as PrimitiveAtom<ReviewsFocus>;

    private constructor() {}

    static getInstance(): ReviewsModel {
        if (ReviewsModel.instance == null) {
            ReviewsModel.instance = new ReviewsModel();
        }
        return ReviewsModel.instance;
    }

    // Opens the Reviews view of the active tab (or focuses it), on a PR when one is named.
    async openReviews(dir?: string, number?: number): Promise<void> {
        if (dir && number) {
            globalStore.set(this.focusAtom, { dir, number, at: Date.now() });
        }
        await openMoltentermView(MoltentermReviewsView);
    }

    // A row's action: the PR's Review tab in this workspace, created the first time, shown after.
    async openPullRequestReview(dir: string, pr: ReviewPr, repo?: string): Promise<void> {
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !workspaceId || !repoName) {
            return;
        }
        getApi().setActiveTab(await openPullRequestTab(workspaceId, dir, pr, repoName));
    }
}

// openPullRequestTab returns the PR's Review tab in the workspace, created the first time (a row's click, `molten review`).
export async function openPullRequestTab(workspaceId: string, dir: string, pr: ReviewPr, repo: string): Promise<string> {
    const { tabid } = await openReviewTab(workspaceId, {
        dir,
        repo,
        number: pr.number,
        title: pr.tickettitle || pr.title,
        url: pr.url,
        headref: pr.branch,
        baseref: pr.base,
        headoid: pr.headoid,
        baseoid: pr.baseoid,
        ticket: pr.ticket,
    });
    return tabid;
}
