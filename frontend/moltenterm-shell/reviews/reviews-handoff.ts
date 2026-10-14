// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten review open|publish|merge` (FR-REV-014): a local terminal asks the window of its workspace, through wavesrv
// (pkg/molten/review/cli.go), to open a PR's Review tab and, for publish and merge, its Publish or Validate sheet. The
// window does what a click on the Reviews row then on the sheet's button would: it reads the PR from the Reviews data
// and opens the tab and the sheet. It never posts nor merges: that stays the developer's click in the sheet.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { fireAndForget } from "@/util/util";
import { reviewKey } from "../review/review-model";
import { ReviewTabModels } from "../review/review-tab-model";
import { reviewsGet } from "./reviews-client";
import { ReviewPr, ReviewsAnswer } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";

// must match pkg/molten/review/cli.go
export const ReviewHandoffEvent = "molten:review:handoff";

export type ReviewHandoffAction = "open" | "publish" | "merge";

export type ReviewHandoff = { id: string; action: ReviewHandoffAction; dir: string; number: number; at: number };

// The sheet a handoff opens, on the Review tab's model once its view mounted and read its review store.
export type ReviewHandoffSheets = { openPublish(): Promise<void>; openValidate(): Promise<void> };

export type ReviewHandoffDeps = {
    reviews: (dir: string) => Promise<ReviewsAnswer>;
    openTab: (dir: string, pr: ReviewPr, repo: string) => Promise<void>;
    // The tab's model once it is ready for a sheet, null when it is not within the wait.
    sheets: (repo: string, number: number) => Promise<ReviewHandoffSheets>;
};

const ModelWaitMs = 15000;
const ModelPollMs = 200;

const handled = new Set<string>();

function readyModel(repo: string, number: number): ReviewHandoffSheets {
    const model = globalStore.get(ReviewTabModels).get(reviewKey(repo, number));
    if (model == null || globalStore.get(model.stateAtom) == null) {
        return null;
    }
    return model;
}

async function waitForSheets(repo: string, number: number): Promise<ReviewHandoffSheets> {
    const deadline = Date.now() + ModelWaitMs;
    for (;;) {
        const model = readyModel(repo, number);
        if (model != null || Date.now() > deadline) {
            return model;
        }
        await new Promise((resolve) => setTimeout(resolve, ModelPollMs));
    }
}

const DefaultDeps: ReviewHandoffDeps = {
    reviews: (dir) => reviewsGet(dir),
    openTab: (dir, pr, repo) => ReviewsModel.getInstance().openPullRequestReview(dir, pr, repo),
    sheets: waitForSheets,
};

export function readHandoff(data: any): ReviewHandoff {
    const actions: ReviewHandoffAction[] = ["open", "publish", "merge"];
    if (data == null || typeof data.id !== "string" || !actions.includes(data.action)) {
        return null;
    }
    if (typeof data.dir !== "string" || !data.dir || !Number.isInteger(data.number) || data.number <= 0) {
        return null;
    }
    return data as ReviewHandoff;
}

// runReviewHandoff opens the PR's Review tab, then the sheet the terminal asked for; true when it did.
export async function runReviewHandoff(h: ReviewHandoff, deps: ReviewHandoffDeps = DefaultDeps): Promise<boolean> {
    const answer = await deps.reviews(h.dir);
    const pr = [...(answer?.ready ?? []), ...(answer?.drafts ?? [])].find((p) => p.number === h.number);
    if (pr == null || !answer.repo) {
        return false;
    }
    await deps.openTab(h.dir, pr, answer.repo);
    if (h.action === "open") {
        return true;
    }
    const sheets = await deps.sheets(answer.repo, h.number);
    if (sheets == null) {
        return false;
    }
    if (h.action === "publish") {
        await sheets.openPublish();
    } else {
        await sheets.openValidate();
    }
    return true;
}

// installReviewHandoff listens for the handoffs of the window's workspace; the returned function stops it.
export function installReviewHandoff(workspaceId: string): () => void {
    if (!workspaceId) {
        return () => {};
    }
    return waveEventSubscribeSingle({
        eventType: ReviewHandoffEvent as WaveEventName,
        scope: workspaceId,
        handler: (event) => {
            const h = readHandoff(event.data);
            if (h == null || handled.has(h.id)) {
                return;
            }
            handled.add(h.id);
            fireAndForget(async () => {
                await runReviewHandoff(h);
            });
        },
    });
}
