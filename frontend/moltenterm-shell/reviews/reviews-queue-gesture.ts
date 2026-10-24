// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Investigate and fix from a merge queue notification (FR-REV-026 AC4, #896): "#N validated but CI failed" hands the
// failed checks to a work agent as the Reviews row's action does; nothing starts before the developer's click on it.

import { globalStore } from "@/app/store/jotaiStore";
import { t } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import { NotificationGestureResult } from "../notifications-store";
import { ReviewsAnswers, reviewsGet } from "./reviews-client";
import { ReviewPr } from "./reviews-model";

// must match InvestigateGesture in pkg/molten/review/batch_notify.go
export const InvestigateGesture = "review:investigate";

async function listedPr(dir: string, number: number): Promise<ReviewPr> {
    const find = () => {
        const answer = globalStore.get(ReviewsAnswers.getInstance().answersAtom)[dir];
        return [...(answer?.ready ?? []), ...(answer?.drafts ?? [])].find((pr) => pr.number === number);
    };
    const known = find();
    if (known != null) {
        return known;
    }
    await reviewsGet(dir, true);
    return find();
}

export async function investigateGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    const dir = typeof args?.dir === "string" ? args.dir : "";
    const repo = typeof args?.repo === "string" ? args.repo : "";
    const number = typeof args?.number === "number" ? args.number : 0;
    if (!dir || !repo || number <= 0) {
        return { ok: false, error: t("reviews.batch.investigateGone") };
    }
    const pr = await listedPr(dir, number);
    if (pr == null) {
        return { ok: false, error: t("reviews.batch.investigateGone") };
    }
    // Loaded on the click: the Reviews store reaches the agent choice, which hosts this gesture.
    const { ReviewsModel } = await import("./reviews-store");
    const outcome = await ReviewsModel.getInstance().investigate(dir, pr, repo);
    if (outcome == null) {
        return { ok: false };
    }
    if (outcome.kind === "failed") {
        return { ok: false, error: wordPhrase(outcome.text) };
    }
    // The notice stays until the PR merges or leaves the queue: the queue resolves it then.
    return { ok: true };
}
