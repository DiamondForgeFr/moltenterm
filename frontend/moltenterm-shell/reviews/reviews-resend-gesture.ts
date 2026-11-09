// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Resend, on the calm notice of a request that waited for its lead's prompt and expired while it still applied (#2145,
// FR-REV-022 AC22): the card's own flow runs again with the PR as the list reads it now, so it is checked like a click
// (the PR open, its head, what remains) and a PR that left the list or was fixed meanwhile sends nothing.

import { globalStore } from "@/app/store/jotaiStore";
import { t } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import { NotificationGestureResult } from "../notifications-store";
import { ReviewsAnswers, reviewsGet } from "./reviews-client";
import type { LeadFacts, ReviewsAnswer } from "./reviews-model";

// must match ResendGesture in pkg/molten/review/handoff_guard.go
export const ReviewsResendGesture = "reviews:resend";

const Tasks = new Set(["rebase", "investigate", "finish"]);

async function answerOf(dir: string): Promise<ReviewsAnswer> {
    const known = globalStore.get(ReviewsAnswers.getInstance().answersAtom)[dir];
    return known ?? (await reviewsGet(dir, true));
}

export async function reviewsResendGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    const dir = typeof args?.dir === "string" ? args.dir : "";
    const number = typeof args?.number === "number" ? args.number : 0;
    const task = typeof args?.task === "string" ? args.task : "";
    if (!dir || number <= 0 || !Tasks.has(task)) {
        return { ok: false, error: t("reviews.resend.failed") };
    }
    let answer: ReviewsAnswer;
    try {
        answer = await answerOf(dir);
    } catch (e) {
        return { ok: false, error: t("reviews.resend.failed") };
    }
    const pr = [...(answer?.ready ?? []), ...(answer?.drafts ?? [])].find((p) => p.number === number);
    if (pr == null) {
        // Merged, closed or gone from the list: there is nothing left to resend, and the notice has nothing to say.
        return { ok: true, resolve: true };
    }
    // Loaded on the click: the Reviews store reaches the agent choice, which hosts this gesture.
    const { ReviewsModel } = await import("./reviews-store");
    const model = ReviewsModel.getInstance();
    const lead: LeadFacts =
        typeof args.leadname === "string" && args.leadname
            ? {
                  name: args.leadname,
                  agent: typeof args.leadagent === "string" ? args.leadagent : undefined,
                  blockId: typeof args.leadblockid === "string" && args.leadblockid ? args.leadblockid : undefined,
                  source: "signature",
              }
            : undefined;
    const outcome =
        task === "finish"
            ? await model.askFinish(dir, pr, answer.repo, args.markready === true, lead)
            : task === "investigate"
              ? await model.investigate(dir, pr, answer.repo)
              : await model.askRebase(dir, pr, answer.repo);
    if (outcome == null) {
        return { ok: false };
    }
    if (outcome.kind === "failed") {
        return { ok: false, error: wordPhrase(outcome.text) };
    }
    return { ok: true, resolve: true };
}
