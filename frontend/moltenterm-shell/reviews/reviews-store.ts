// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's entry points (FR-REV-001-AC3, DS-REV-012): the widget opens the view, Mission Control's Pull
// requests waiting block opens it on one PR, and a row opens that PR's Review tab (FR-REV-002).

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { openMoltentermView } from "../open-view";
import { askReviewRebase, markReviewReady, openReviewTab } from "../review/review-client";
import { requestReviewSheet } from "../review/review-sheet-request";
import { reviewsGet } from "./reviews-client";
import {
    markReadyError,
    MoltentermReviewsView,
    ReadiedPrs,
    RebaseAsk,
    rebaseAskKey,
    rebaseOutcome,
    RebaseOutcome,
    repoOfPrUrl,
    ReviewPr,
} from "./reviews-model";

// The PR a Reviews view brings into sight and marks, asked by another surface.
export type ReviewsFocus = { dir: string; number: number; at: number };

export class ReviewsModel {
    private static instance: ReviewsModel = null;

    focusAtom = atom(null) as PrimitiveAtom<ReviewsFocus>;
    // The rebases asked from the rows (#683), by rebaseAskKey.
    rebaseAsksAtom = atom({}) as PrimitiveAtom<Record<string, RebaseAsk>>;
    // The drafts marked ready from MoltenTerm (#687), by rebaseAskKey: splitReviews moves them at once.
    readiedAtom = atom({}) as PrimitiveAtom<ReadiedPrs>;

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

    // A row's Validate (#683): the PR's Review tab with its Validate sheet, which shows the plan; merging stays the
    // developer's click there.
    async openValidate(dir: string, pr: ReviewPr, repo?: string): Promise<void> {
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !workspaceId || !repoName) {
            return;
        }
        const tabId = await openPullRequestTab(workspaceId, dir, pr, repoName);
        if (!tabId) {
            return;
        }
        await requestReviewSheet(tabId, { id: crypto.randomUUID(), action: "merge", at: Date.now() });
        getApi().setActiveTab(tabId);
    }

    // A row's Ask for a rebase (#683): the agent on the PR's branch gets it; with start, the developer accepted to start
    // one, in the PR's Review tab (Restart work's flow). An agent reached marks the row until the PR's head changes.
    async askRebase(dir: string, pr: ReviewPr, repo: string, start: boolean): Promise<RebaseOutcome> {
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return null;
        }
        let tabid: string;
        if (start) {
            const workspaceId = globalStore.get(atoms.workspace)?.oid;
            if (!workspaceId) {
                return null;
            }
            tabid = await openPullRequestTab(workspaceId, dir, pr, repoName);
        }
        let outcome: RebaseOutcome;
        try {
            const result = await askReviewRebase({
                repo: repoName,
                number: pr.number,
                dir,
                headref: pr.branch,
                baseref: pr.base,
                headoid: pr.headoid,
                title: pr.tickettitle || pr.title,
                url: pr.url,
                ticket: pr.ticket,
                start: start || undefined,
                tabid,
            });
            outcome = rebaseOutcome(result);
        } catch (e) {
            outcome = rebaseOutcome(null, String(e?.message ?? e));
        }
        if (outcome?.kind === "asked") {
            const key = rebaseAskKey(dir, pr.number);
            const asks = globalStore.get(this.rebaseAsksAtom);
            globalStore.set(this.rebaseAsksAtom, {
                ...asks,
                [key]: { name: outcome.name, head: pr.headoid ?? "", at: Date.now() },
            });
        }
        return outcome;
    }

    // Mark ready for review (#687), from a draft's row or its Review tab: gh pr ready, then the list moves the PR to
    // Waiting for review and asks GitHub again. Answers the error in plain words, "" on success.
    async markReady(dir: string, number: number, repo: string): Promise<string> {
        if (!dir || !number || !repo) {
            return markReadyError(null);
        }
        let error: string;
        try {
            error = markReadyError(await markReviewReady({ repo, number, dir }));
        } catch (e) {
            error = markReadyError(null, String(e?.message ?? e));
        }
        if (error) {
            return error;
        }
        const key = rebaseAskKey(dir, number);
        globalStore.set(this.readiedAtom, { ...globalStore.get(this.readiedAtom), [key]: Date.now() });
        fireAndForget(async () => {
            await reviewsGet(dir, true);
        });
        return "";
    }
}

// openPullRequestTab returns the PR's Review tab in the workspace, created the first time (a row's click, `molten review`).
export async function openPullRequestTab(
    workspaceId: string,
    dir: string,
    pr: ReviewPr,
    repo: string
): Promise<string> {
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
