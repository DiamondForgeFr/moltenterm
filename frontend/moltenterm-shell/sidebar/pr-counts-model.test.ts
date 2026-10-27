// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { rebaseAskKey, ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import { firstPilotageTab, hasPrCounts, prCounts, prCountText } from "./pr-counts-model";

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "success", success: 3, failure: 0, pending: 0, checks: [] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

function answer(extra: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return { dir: "/p", state: "ok", ready: [], drafts: [], githubat: 100, ...extra };
}

const running = { state: "pending" as const, success: 1, failure: 0, pending: 2, checks: [] };
const failing = { state: "failure" as const, success: 1, failure: 1, pending: 0, checks: [] };

describe("prCounts (FR-SHELL-085)", () => {
    it("counts ready, CI running or failing, and drafts", () => {
        const counts = prCounts(
            answer({
                ready: [pr(1), pr(2), pr(3, { ci: running }), pr(4, { ci: failing }), pr(5, { merge: "conflicts" })],
                drafts: [pr(6, { draft: true, ci: failing }), pr(7, { draft: true })],
            })
        );
        expect(counts).toEqual({ ready: 3, ci: 2, draft: 2 });
    });

    it("reads a merge state that says CI runs or fails as CI", () => {
        expect(prCounts(answer({ ready: [pr(1, { merge: "running" }), pr(2, { merge: "failing" })] }))).toEqual({
            ready: 0,
            ci: 2,
            draft: 0,
        });
    });

    it("follows Pilotage's split: a draft marked ready here counts as ready", () => {
        const readied = { [rebaseAskKey("/p", 9)]: 200 };
        expect(prCounts(answer({ drafts: [pr(9, { draft: true })] }), readied)).toEqual({ ready: 1, ci: 0, draft: 0 });
    });

    it("shows nothing while GitHub could not be read", () => {
        expect(prCounts(answer({ state: "loggedout", ready: [pr(1)] }))).toEqual({ ready: 0, ci: 0, draft: 0 });
        expect(prCounts(null)).toEqual({ ready: 0, ci: 0, draft: 0 });
        expect(hasPrCounts(prCounts(null))).toBe(false);
        expect(hasPrCounts({ ready: 0, ci: 0, draft: 1 })).toBe(true);
    });

    it("caps a pill at 99+", () => {
        expect(prCountText(7)).toBe("7");
        expect(prCountText(99)).toBe("99");
        expect(prCountText(100)).toBe("99+");
    });
});

describe("firstPilotageTab (FR-SHELL-085: one place per area)", () => {
    it("picks the first block whose view holds Pilotage", () => {
        expect(
            firstPilotageTab([
                { tabId: "a", views: ["term"] },
                { tabId: "b", views: ["term", "molten-reviews"] },
                { tabId: "c", views: ["molten-reviews"] },
            ])
        ).toBe("b");
    });

    it("gives none when no block shows Pilotage", () => {
        expect(firstPilotageTab([{ tabId: "a", views: ["web"] }])).toBe("");
        expect(firstPilotageTab([])).toBe("");
    });
});
