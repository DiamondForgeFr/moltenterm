// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's entry points (FR-REV-001-AC3, DS-REV-012): the widget opens the view, Mission Control's Pull
// requests waiting block opens it on one PR, and a row opens that PR's review. The Review tab comes with FR-REV-002
// (#580): openPullRequestReview is the one place it plugs into.

import { openLink } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { openMoltentermView } from "../open-view";
import { MoltentermReviewsView, ReviewPr } from "./reviews-model";

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

    // A row's action: the PR's Review tab. Until FR-REV-002 (#580) brings it, the PR opens on GitHub.
    async openPullRequestReview(dir: string, pr: ReviewPr): Promise<void> {
        if (!dir || pr == null) {
            return;
        }
        await openLink(pr.url);
    }
}
