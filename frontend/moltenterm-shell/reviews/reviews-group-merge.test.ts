// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The choice of the PRs in the group merge (#1108, FR-REV-024): the card menu's entry and the model that keeps it.

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReviewPr } from "./reviews-model";
import { groupMergeAction } from "./reviews-queue-model";
import { ReviewsModel } from "./reviews-store";

function pr(number: number): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/acme/shop/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "",
        updatedat: "",
        merge: "clean",
        unpublished: 0,
    } as ReviewPr;
}

describe("group merge choice (#1108)", () => {
    const model = ReviewsModel.getInstance();
    beforeEach(() => globalStore.set(model.groupOutAtom, {}));

    it("offers Take out on a chosen card, Add on a taken-out one, nothing on a PR that is no step", () => {
        expect(groupMergeAction("in")).toEqual({ labelKey: "reviews.card.groupTakeOut", inGroup: false });
        expect(groupMergeAction("out")).toEqual({ labelKey: "reviews.card.groupAdd", inGroup: true });
        expect(groupMergeAction(null)).toBeNull();
    });

    it("keeps the PRs taken out per project, puts one back, and forgets those that left the list", () => {
        model.setInGroupMerge("/shop", 1201, false);
        model.setInGroupMerge("/shop", 1203, false);
        model.setInGroupMerge("/other", 7, false);
        expect(globalStore.get(model.groupOutAtom)["/shop"]).toEqual([1201, 1203]);
        model.setInGroupMerge("/shop", 1201, true);
        expect(globalStore.get(model.groupOutAtom)["/shop"]).toEqual([1203]);
        model.setInGroupMerge("/shop", 1201, false);
        model.forgetLeftGroupOut("/shop", [pr(1201), pr(1204)]);
        expect(globalStore.get(model.groupOutAtom)["/shop"]).toEqual([1201]);
        expect(globalStore.get(model.groupOutAtom)["/other"]).toEqual([7]);
    });
});
