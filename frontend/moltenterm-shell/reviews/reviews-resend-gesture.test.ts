// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2145 (FR-REV-022 AC22): Resend, on the calm notice of a request that expired while it still applied, runs the card's
// own flow with the PR as the list reads it now.

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phrase } from "../i18n/phrase";
import { ReviewsAnswers } from "./reviews-client";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import { ReviewsResendGesture, reviewsResendGesture } from "./reviews-resend-gesture";
import { ReviewsModel } from "./reviews-store";

const Pr: ReviewPr = {
    number: 2139,
    title: "Hand-offs check the head",
    url: "https://github.com/acme/app/pull/2139",
    branch: "fix/2137-handoffs",
    base: "develop",
    headoid: "02d4ec6760000000000000000000000000000bbb",
    createdat: "",
    updatedat: "",
    merge: "conflicts",
    ci: { state: "none", success: 0, failure: 0, pending: 0, checks: [] },
    report: { state: "present" },
    unpublished: 0,
};

function listed(prs: ReviewPr[]) {
    const answer: ReviewsAnswer = {
        dir: "/p",
        state: "ok",
        repo: "acme/app",
        target: "develop",
        ready: prs,
        drafts: [],
    };
    globalStore.set(ReviewsAnswers.getInstance().answersAtom, { "/p": answer });
}

const Asked = { kind: "asked" as const, name: "Arthur", text: phrase("reviews.rebase.asked", { name: "Arthur" }) };

beforeEach(() => listed([Pr]));
afterEach(() => {
    vi.restoreAllMocks();
    globalStore.set(ReviewsAnswers.getInstance().answersAtom, {});
});

describe("Resend on a request that expired (#2145)", () => {
    it("is the gesture wavesrv's notice names", () => {
        expect(ReviewsResendGesture).toBe("reviews:resend");
    });

    it("runs Resume again on the PR as the list has it, for the same lead", async () => {
        const ask = vi.spyOn(ReviewsModel.getInstance(), "askFinish").mockResolvedValue(Asked);
        const result = await reviewsResendGesture({
            dir: "/p",
            number: 2139,
            task: "finish",
            markready: true,
            leadname: "Nathan",
            leadagent: "claude",
            leadblockid: "blk-nathan",
        });
        expect(result).toEqual({ ok: true, resolve: true });
        expect(ask).toHaveBeenCalledWith("/p", Pr, "acme/app", true, {
            name: "Nathan",
            agent: "claude",
            blockId: "blk-nathan",
            source: "signature",
        });
    });

    it("runs the rebase and the analysis the same way", async () => {
        const model = ReviewsModel.getInstance();
        const rebase = vi.spyOn(model, "askRebase").mockResolvedValue(Asked);
        const investigate = vi.spyOn(model, "investigate").mockResolvedValue(Asked);
        await reviewsResendGesture({ dir: "/p", number: 2139, task: "rebase" });
        await reviewsResendGesture({ dir: "/p", number: 2139, task: "investigate" });
        expect(rebase).toHaveBeenCalledWith("/p", Pr, "acme/app");
        expect(investigate).toHaveBeenCalledWith("/p", Pr, "acme/app");
    });

    it("sends nothing for a PR that left the list, and closes the notice", async () => {
        listed([]);
        const ask = vi.spyOn(ReviewsModel.getInstance(), "askFinish").mockResolvedValue(Asked);
        expect(await reviewsResendGesture({ dir: "/p", number: 2139, task: "finish" })).toEqual({
            ok: true,
            resolve: true,
        });
        expect(ask).not.toHaveBeenCalled();
    });

    it("says what the flow found out: nothing is resent for a PR that changed", async () => {
        const stale = {
            kind: "info" as const,
            stale: true,
            text: phrase("reviews.rebase.stale.problemGone", { head: "02d4ec6" }),
        };
        vi.spyOn(ReviewsModel.getInstance(), "askFinish").mockResolvedValue(stale);
        expect(await reviewsResendGesture({ dir: "/p", number: 2139, task: "finish" })).toEqual({
            ok: true,
            resolve: true,
        });
    });

    it("reports a flow that failed and refuses a task it does not know", async () => {
        vi.spyOn(ReviewsModel.getInstance(), "askRebase").mockResolvedValue({
            kind: "failed",
            text: phrase("reviews.rebase.terminal"),
        });
        const failed = await reviewsResendGesture({ dir: "/p", number: 2139, task: "rebase" });
        expect(failed.ok).toBe(false);
        expect(failed.error).toBeTruthy();
        expect((await reviewsResendGesture({ dir: "/p", number: 2139, task: "merge" })).ok).toBe(false);
        expect((await reviewsResendGesture({ dir: "", number: 2139, task: "rebase" })).ok).toBe(false);
    });
});
