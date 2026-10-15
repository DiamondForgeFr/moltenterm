// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Validate sheet's state and actions (FR-REV-012), apart from the Review tab (#707): a Review tab owns one, and a
// Reviews row's Validate opens one in place, with no Review tab. It follows one PR's review store (the merge record and
// the cleanup's outcome), reads the plan, merges on the developer's click and handles the worktrees the cleanup kept.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { reviewsGet } from "../reviews/reviews-client";
import { removeKeptWorktree, ReviewCleanupStepResult } from "./review-cleanup";
import {
    reviewMerge,
    reviewMergeCancel,
    ReviewMergeMethod,
    ReviewMergePlan,
    reviewMergePlan,
    ReviewPrInfo,
    reviewState,
    ReviewState,
    subscribeReviewState,
} from "./review-client";
import { chosenMethod, mergeRunning } from "./review-merge";
import { closePanels } from "./review-panels";

// Validate's plan sheet (FR-REV-012): the plan read on opening it, the developer's confirmation of its warnings, and
// the plan whose merge was clicked, so the sheet follows that merge in the review store.
export type ReviewValidateState = {
    open: boolean;
    loading: boolean;
    plan?: ReviewMergePlan;
    error?: string;
    override: boolean;
    // The merge method chosen in the sheet (#673): the plan's default until the developer picks another.
    method?: ReviewMergeMethod;
    clicked?: string;
    // The agent worktree's removal the developer confirmed after the merge's cleanup is running.
    confirming?: boolean;
    // The sheet reopened from the header's Validated state (#686): the merge's result, read-only.
    result?: boolean;
};

// Where the sheet shows. In a Review tab, the merged footer offers to close the tab (#686) and new commits are
// reviewed there; with no tab (#707), the sheet only closes and new commits open the PR's Review tab.
export type ReviewValidateHost = {
    inTab: boolean;
    reviewNewCommits(): Promise<void>;
    closeTab?(): void;
};

const ClosedSheet: ReviewValidateState = { open: false, loading: false, override: false };

export class ReviewValidateModel {
    prAtom: Atom<ReviewPrInfo>;
    stateAtom: PrimitiveAtom<ReviewState>;
    validateAtom = atom(ClosedSheet) as PrimitiveAtom<ReviewValidateState>;
    host: ReviewValidateHost;

    constructor(prAtom: Atom<ReviewPrInfo>, stateAtom: PrimitiveAtom<ReviewState>, host: ReviewValidateHost) {
        this.prAtom = prAtom;
        this.stateAtom = stateAtom;
        this.host = host;
    }

    pr(): ReviewPrInfo {
        return globalStore.get(this.prAtom);
    }

    // applyState takes the store's state; a merge that just ended refreshes the Reviews list once (DS-REV-001: right
    // after a MoltenTerm action).
    applyState(state: ReviewState) {
        const before = globalStore.get(this.stateAtom)?.merge;
        globalStore.set(this.stateAtom, state);
        const after = state?.merge;
        if (after == null || !mergeRunning(before) || mergeRunning(after) || before.planid !== after.planid) {
            return;
        }
        const pr = this.pr();
        fireAndForget(async () => {
            await reviewsGet(pr.dir, true);
        });
    }

    // Validate (FR-REV-012, AC1): the plan sheet opens on a fresh read of the PR. Nothing merges until Merge is
    // clicked on it.
    async openValidate() {
        globalStore.set(this.validateAtom, { open: true, loading: true, override: false });
        await this.loadPlan();
    }

    // The Validated state's click (#686): the sheet shows the merge's result, read-only.
    openValidateResult() {
        globalStore.set(this.validateAtom, { open: true, loading: false, override: false, result: true });
    }

    async loadPlan() {
        const pr = this.pr();
        globalStore.set(this.validateAtom, (v) => ({ ...v, loading: true, error: null }));
        try {
            const plan = await reviewMergePlan({ dir: pr.dir, repo: pr.repo, number: pr.number, ticket: pr.ticket });
            globalStore.set(this.validateAtom, (v) =>
                v.open ? { ...v, loading: false, plan, override: false, method: chosenMethod(plan, v.method) } : v
            );
        } catch (e) {
            globalStore.set(this.validateAtom, (v) => ({ ...v, loading: false, error: String(e?.message ?? e) }));
        }
    }

    closeValidate() {
        globalStore.set(this.validateAtom, ClosedSheet);
    }

    // Close the Review tab from the merged sheet (#686): through the tab's own close path.
    closeValidateAndTab() {
        this.closeValidate();
        this.host.closeTab?.();
    }

    setValidateOverride(override: boolean) {
        globalStore.set(this.validateAtom, (v) => ({ ...v, override }));
    }

    setValidateMethod(method: ReviewMergeMethod) {
        globalStore.set(this.validateAtom, (v) => (v.plan?.methods?.includes(method) ? { ...v, method } : v));
    }

    // merge is the developer's click (AC5): wavesrv checks the plan and the head again, then reports in the store.
    async merge() {
        const pr = this.pr();
        const v = globalStore.get(this.validateAtom);
        if (v.plan == null) {
            return;
        }
        globalStore.set(this.validateAtom, (s) => ({ ...s, clicked: v.plan.id, error: null }));
        try {
            const record = await reviewMerge(pr.repo, pr.number, v.plan.id, v.override, chosenMethod(v.plan, v.method));
            // The store's event may have come first with a newer step of this merge.
            globalStore.set(this.stateAtom, (state) =>
                state && state.merge?.planid !== record.planid ? { ...state, merge: record } : state
            );
        } catch (e) {
            globalStore.set(this.validateAtom, (s) => ({ ...s, clicked: null, error: String(e?.message ?? e) }));
        }
    }

    async cancelMerge() {
        const pr = this.pr();
        try {
            await reviewMergeCancel(pr.repo, pr.number);
        } catch (e) {
            globalStore.set(this.validateAtom, (s) => ({ ...s, error: String(e?.message ?? e) }));
        }
    }

    // A worktree the merge's cleanup kept (FR-REV-013, #672), because removing it loses work or a panel still works in
    // it: the panels are closed first, then wavesrv reads the folder again and removes it (the agent worktree with its
    // branch, losing what the sheet named). The outcome comes back in the review store.
    async removeKeptWorktree(step: ReviewCleanupStepResult) {
        const pr = this.pr();
        const ticket = globalStore.get(this.validateAtom).plan?.ticket;
        globalStore.set(this.validateAtom, (s) => ({ ...s, confirming: true, error: null }));
        try {
            await closePanels((step.panels ?? []).map((p) => p.blockid));
            await removeKeptWorktree({ dir: pr.dir, repo: pr.repo, number: pr.number, ticket }, step);
        } catch (e) {
            globalStore.set(this.validateAtom, (s) => ({ ...s, error: String(e?.message ?? e) }));
        } finally {
            globalStore.set(this.validateAtom, (s) => ({ ...s, confirming: false }));
        }
    }

    // After a refusal on new commits (AC2): the sheet closes and the new head is shown where the PR is reviewed.
    async reviewNewCommits() {
        this.closeValidate();
        await this.host.reviewNewCommits();
    }
}

// openSheetValidate opens a Validate sheet with no Review tab (#707): it reads the PR's review store and follows it
// until the returned stop is called. The sheet itself opens on a fresh plan.
export function openSheetValidate(
    pr: ReviewPrInfo,
    reviewNewCommits: () => Promise<void>
): { model: ReviewValidateModel; stop: () => void } {
    const model = new ReviewValidateModel(atom(pr), atom(null) as PrimitiveAtom<ReviewState>, {
        inTab: false,
        reviewNewCommits,
    });
    let stopped = false;
    const unsub = subscribeReviewState(pr.repo, pr.number, (state) => model.applyState(state));
    fireAndForget(async () => {
        try {
            const state = await reviewState(pr.repo, pr.number);
            // An event may have brought a newer state while the store was read.
            if (!stopped && globalStore.get(model.stateAtom) == null) {
                globalStore.set(model.stateAtom, state);
            }
        } catch (e) {
            console.log("[review] the review store could not be read", e);
        }
    });
    globalStore.set(model.validateAtom, { open: true, loading: true, override: false });
    fireAndForget(() => model.loadPlan());
    return {
        model,
        stop: () => {
            stopped = true;
            unsub();
        },
    };
}
