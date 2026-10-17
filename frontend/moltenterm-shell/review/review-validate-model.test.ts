// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({
    handlers: [] as ((state: any) => void)[],
    unsub: vi.fn(),
    reviewState: vi.fn(async () => ({ updatedat: 1 }) as any),
    plan: vi.fn(async () => ({ id: "p1", canmerge: true, methods: ["rebase"] }) as any),
    merge: vi.fn(async () => ({ planid: "p1", state: "merging" }) as any),
    reviewsGet: vi.fn(async () => null as any),
}));

vi.mock("./review-client", () => ({
    reviewMerge: Mocks.merge,
    reviewMergeCancel: vi.fn(async () => {}),
    reviewMergePlan: Mocks.plan,
    reviewState: Mocks.reviewState,
    subscribeReviewState: (_repo: string, _num: number, handler: (state: any) => void) => {
        Mocks.handlers.push(handler);
        return Mocks.unsub;
    },
}));
vi.mock("../reviews/reviews-client", () => ({ reviewsGet: Mocks.reviewsGet }));
vi.mock("./review-cleanup", () => ({ removeKeptWorktree: vi.fn(async () => {}) }));
vi.mock("./review-panels", () => ({ closePanels: vi.fn(async () => {}) }));

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { ReviewsMerges } from "../reviews/reviews-merges";
import { openSheetValidate, ReviewValidateModel } from "./review-validate-model";

const Pr = { dir: "/p", repo: "o/r", number: 7, headref: "fix/7-x", baseref: "develop", ticket: 7 };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a Reviews row's Validate sheet, with no Review tab (#707)", () => {
    it("opens on the plan, follows the PR's review store and stops following it", async () => {
        Mocks.handlers = [];
        Mocks.unsub.mockClear();
        const back = vi.fn(async () => {});
        const { model, stop } = openSheetValidate(Pr, back);
        expect(model.host.inTab).toBe(false);
        expect(globalStore.get(model.validateAtom).open).toBe(true);
        await flush();
        expect(Mocks.plan).toHaveBeenCalledWith({ dir: "/p", repo: "o/r", number: 7, ticket: 7 });
        expect(globalStore.get(model.validateAtom).plan?.id).toBe("p1");
        expect(globalStore.get(model.stateAtom)).toEqual({ updatedat: 1 });
        Mocks.handlers[0]({ updatedat: 2, merge: { planid: "p1", state: "merging" } });
        expect(globalStore.get(model.stateAtom).merge.state).toBe("merging");
        Mocks.reviewsGet.mockClear();
        Mocks.handlers[0]({ updatedat: 3, merge: { planid: "p1", state: "merged", cleanuprunning: true } });
        expect(Mocks.reviewsGet).toHaveBeenCalledWith("/p", true);
        stop();
        expect(Mocks.unsub).toHaveBeenCalledTimes(1);
    });

    it("merges on the click, and only closes the sheet: no tab to close", async () => {
        const back = vi.fn(async () => {});
        const { model, stop } = openSheetValidate(Pr, back);
        await flush();
        await model.merge();
        expect(Mocks.merge).toHaveBeenCalledWith("o/r", 7, "p1", false, "rebase");
        expect(globalStore.get(model.validateAtom).clicked).toBe("p1");
        model.closeValidate();
        expect(globalStore.get(model.validateAtom).open).toBe(false);
        expect(back).not.toHaveBeenCalled();
        model.closeValidateAndTab();
        expect(globalStore.get(model.validateAtom).open).toBe(false);
        stop();
    });

    it("tells the Reviews list the merge as soon as the store says merged, and starts no validation after (#898)", async () => {
        ReviewsMerges.resetInstance();
        Mocks.handlers = [];
        const { model, stop } = openSheetValidate(
            Pr,
            vi.fn(async () => {})
        );
        await flush();
        expect(ReviewsMerges.getInstance().isMerged("/p", 7)).toBe(false);
        Mocks.handlers[0]({ updatedat: 2, merge: { planid: "p1", state: "merged", mergedoid: "m7", endedat: 42 } });
        expect(ReviewsMerges.getInstance().isMerged("/p", 7)).toBe(true);
        expect(globalStore.get(ReviewsMerges.getInstance().mergesAtom)["/p#7"]).toMatchObject({
            byyou: true,
            oid: "m7",
            mergedat: 42,
            base: "develop",
        });
        Mocks.plan.mockClear();
        await model.openValidate();
        expect(Mocks.plan).not.toHaveBeenCalled();
        expect(globalStore.get(model.validateAtom)).toMatchObject({ open: true, result: true });
        stop();
    });

    it("notes a PR a Validate found merged away, and a Review tab's host refuses a validation on a merged PR", async () => {
        ReviewsMerges.resetInstance();
        Mocks.handlers = [];
        const { model, stop } = openSheetValidate(
            Pr,
            vi.fn(async () => {})
        );
        await flush();
        Mocks.handlers[0]({ updatedat: 3, merge: { planid: "p1", state: "refused", refused: "mergedaway" } });
        expect(globalStore.get(ReviewsMerges.getInstance().mergesAtom)["/p#7"].byyou).toBe(false);
        stop();
        ReviewsMerges.resetInstance();
        const tab = new ReviewValidateModel(atom(Pr), atom(null) as PrimitiveAtom<any>, {
            inTab: true,
            reviewNewCommits: vi.fn(async () => {}),
            isMerged: () => true,
        });
        Mocks.plan.mockClear();
        await tab.openValidate();
        expect(Mocks.plan).not.toHaveBeenCalled();
        expect(globalStore.get(tab.validateAtom).open).toBe(false);
    });

    it("hands the new commits to the PR's Review tab after a refusal on a moved head", async () => {
        const back = vi.fn(async () => {});
        const { model, stop } = openSheetValidate(Pr, back);
        await flush();
        await model.reviewNewCommits();
        expect(globalStore.get(model.validateAtom).open).toBe(false);
        expect(back).toHaveBeenCalledTimes(1);
        stop();
    });
});
