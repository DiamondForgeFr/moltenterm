// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's entry points (FR-REV-001-AC3, DS-REV-012): the widget opens the view, Mission Control's Pull
// requests waiting block opens it on one PR, and a row opens that PR's Review tab (FR-REV-002).

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { t } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { openMoltentermView } from "../open-view";
import { showTabFromHere } from "../opener-tab";
import type { ReviewCleanupPr, ReviewCleanupResult } from "../review/review-cleanup";
import {
    askReviewInvestigate,
    askReviewRebase,
    markReviewReady,
    openReviewTab,
    ReviewPrInfo,
} from "../review/review-client";
import { openSheetValidate, ReviewValidateModel } from "../review/review-validate-model";
import { AgentChoiceAnswer, agentChoiceOf, agentStartOf, askAgentChoice, showStartedAgent } from "./agent-choice";
import { reviewsGet, reviewsRerunFailed } from "./reviews-client";
import {
    checkNames,
    checksOf,
    cleanupRebaseAsks,
    markReadyError,
    MoltentermReviewsView,
    ReadiedPrs,
    RebaseAsk,
    rebaseAskKey,
    rebaseOutcome,
    RebaseOutcome,
    repoOfPrUrl,
    ReviewPr,
    reviewPrOfCleanup,
} from "./reviews-model";

// The PR a Reviews view brings into sight and marks, asked by another surface.
export type ReviewsFocus = { dir: string; number: number; at: number };

export type ReviewsValidateSheet = { model: ReviewValidateModel; blockId?: string };

export class ReviewsModel {
    private static instance: ReviewsModel = null;

    focusAtom = atom(null) as PrimitiveAtom<ReviewsFocus>;
    // The rebases asked from the rows (#683), by rebaseAskKey.
    rebaseAsksAtom = atom({}) as PrimitiveAtom<Record<string, RebaseAsk>>;
    // The drafts marked ready from MoltenTerm (#687), by rebaseAskKey: splitReviews moves them at once.
    readiedAtom = atom({}) as PrimitiveAtom<ReadiedPrs>;
    // A row's Validate sheet, open with no Review tab (#707), in the Reviews panel blockId.
    validateSheetAtom = atom(null) as PrimitiveAtom<ReviewsValidateSheet>;
    stopSheet: () => void = null;

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
        showTabFromHere(await openPullRequestTab(workspaceId, dir, pr, repoName));
    }

    // A row's Validate (#683, #707): the Validate sheet opens in place, over this tab, with no Review tab; it shows the
    // plan, and merging stays the developer's click there. blockId is the Reviews panel that shows it.
    openValidate(dir: string, pr: ReviewPr, repo?: string, blockId?: string) {
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return;
        }
        this.closeValidateSheet();
        const opened = openSheetValidate(reviewPrInfo(dir, pr, repoName), () =>
            this.openPullRequestReview(dir, pr, repoName)
        );
        const unsub = globalStore.sub(opened.model.validateAtom, () => {
            if (!globalStore.get(opened.model.validateAtom).open) {
                this.closeValidateSheet();
            }
        });
        this.stopSheet = () => {
            unsub();
            opened.stop();
        };
        globalStore.set(this.validateSheetAtom, { model: opened.model, blockId });
    }

    closeValidateSheet() {
        const stop = this.stopSheet;
        this.stopSheet = null;
        stop?.();
        globalStore.set(this.validateSheetAtom, null);
    }

    // A row's Ask for a rebase (#683): the agent on the PR's branch gets it. With none there, the developer chooses how
    // one starts (#758): out of sight, or in its own tab shown by this window; never the PR's Review tab. An agent
    // reached marks the row until the PR's head changes. mergedPr: the merge that put the PR in conflict (#691).
    async askRebase(dir: string, pr: ReviewPr, repo: string, mergedPr?: number): Promise<RebaseOutcome> {
        const outcome = await this.askRebaseOnce(dir, pr, repo, null, mergedPr);
        if (outcome?.kind !== "offer") {
            return outcome;
        }
        const choice = await askAgentChoice({
            kind: "rebase",
            number: pr.number,
            branch: pr.branch,
            base: pr.base,
            agent: outcome.agent,
            ...agentChoiceOf(outcome.result),
        });
        if (choice == null) {
            return null;
        }
        return this.askRebaseOnce(dir, pr, repo, choice, mergedPr);
    }

    private async askRebaseOnce(
        dir: string,
        pr: ReviewPr,
        repo: string,
        choice: AgentChoiceAnswer,
        mergedPr?: number
    ): Promise<RebaseOutcome> {
        const mode = choice?.mode;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return null;
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
                mergedpr: mergedPr || undefined,
                ...(mode != null ? agentStartOf("rebase", pr.number, mode, choice.agent) : {}),
            });
            showStartedAgent(mode, result);
            outcome = rebaseOutcome(result);
        } catch (e) {
            outcome = rebaseOutcome(null, serverErrorText(e));
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

    // The rebases the cleanup after a merge asked (#691) mark their Reviews rows like a row's click.
    noteCleanupRebases(dir: string, cleanup: ReviewCleanupResult) {
        if (!dir || cleanup == null) {
            return;
        }
        const asks = globalStore.get(this.rebaseAsksAtom);
        const next = cleanupRebaseAsks(asks, dir, cleanup);
        if (next !== asks) {
            globalStore.set(this.rebaseAsksAtom, next);
        }
    }

    // Start an agent on a PR the merge of mergedPr put in conflict (#691), from the Validate sheet: Ask for a rebase,
    // with the same choice (#758).
    startCleanupAgent(
        dir: string,
        repo: string,
        base: string,
        pr: ReviewCleanupPr,
        mergedPr?: number
    ): Promise<RebaseOutcome> {
        return this.askRebase(dir, reviewPrOfCleanup(pr, base), repo, mergedPr);
    }

    // Investigate (#797), on a row whose check failed: the agent on the PR's branch reads the failed checks; with none
    // there, the developer chooses how one starts, as for a rebase. Nothing starts before that click.
    async investigate(dir: string, pr: ReviewPr, repo: string): Promise<RebaseOutcome> {
        const outcome = await this.investigateOnce(dir, pr, repo, null);
        if (outcome?.kind !== "offer") {
            return outcome;
        }
        const choice = await askAgentChoice({
            kind: "investigate",
            number: pr.number,
            branch: pr.branch,
            base: pr.base,
            agent: outcome.agent,
            checks: checkNames(checksOf(pr.ci, "failure")),
            ...agentChoiceOf(outcome.result),
        });
        if (choice == null) {
            return null;
        }
        return this.investigateOnce(dir, pr, repo, choice);
    }

    private async investigateOnce(
        dir: string,
        pr: ReviewPr,
        repo: string,
        choice: AgentChoiceAnswer
    ): Promise<RebaseOutcome> {
        const mode = choice?.mode;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return null;
        }
        try {
            const result = await askReviewInvestigate({
                repo: repoName,
                number: pr.number,
                dir,
                headref: pr.branch,
                baseref: pr.base,
                headoid: pr.headoid,
                title: pr.tickettitle || pr.title,
                url: pr.url,
                ticket: pr.ticket,
                checks: checksOf(pr.ci, "failure").map((c) => ({
                    name: c.name,
                    workflow: c.workflow,
                    url: c.url,
                    runid: c.runid,
                    jobid: c.jobid,
                })),
                ...(mode != null ? agentStartOf("investigate", pr.number, mode, choice.agent) : {}),
            });
            showStartedAgent(mode, result);
            return rebaseOutcome(result, null, "investigate");
        } catch (e) {
            return rebaseOutcome(null, serverErrorText(e), "investigate");
        }
    }

    // Rerun failed jobs (#797), after the row's confirmation: wavesrv reruns the runs of the failed checks and tells
    // their outcome by a notification; the list reads GitHub again. Answers the error in plain words, "" on success.
    async rerunFailed(dir: string, number: number): Promise<{ error: string; checks: string[] }> {
        if (!dir || !number) {
            return { error: t("reviews.ci.rerun.failed", { message: "" }), checks: [] };
        }
        try {
            const result = await reviewsRerunFailed(dir, number);
            fireAndForget(async () => {
                await reviewsGet(dir, true);
            });
            return { error: "", checks: result?.checks ?? [] };
        } catch (e) {
            return { error: t("reviews.ci.rerun.failed", { message: serverErrorText(e) }), checks: [] };
        }
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
            error = markReadyError(null, serverErrorText(e));
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
    const { tabid } = await openReviewTab(workspaceId, reviewPrInfo(dir, pr, repo));
    return tabid;
}

// reviewPrInfo is the PR as a Review tab and the Validate sheet know it, from a Reviews row.
export function reviewPrInfo(dir: string, pr: ReviewPr, repo: string): ReviewPrInfo {
    return {
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
    };
}
