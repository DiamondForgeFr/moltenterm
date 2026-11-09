// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2145 (FR-REV-022 AC22): a hand-off wavesrv found out of date (the PR moved on, what was asked is gone) sent nothing,
// and the card keeps saying so until it is asked again, in whichever section the refreshed PR lands it.

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTestMatrix } from "../agent-info/agent-features-fixture";
import { ReviewRow } from "./reviews-card";
import { rebaseOutcome, ReviewPr } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";

setTestMatrix();

const Head = "02d4ec6760000000000000000000000000000bbb";

const Pr: ReviewPr = {
    number: 2139,
    ticket: 2137,
    title: "Hand-offs check the head",
    url: "https://github.com/acme/app/pull/2139",
    branch: "fix/2137-handoffs",
    base: "develop",
    headoid: Head,
    createdat: "",
    updatedat: "",
    merge: "conflicts",
    ci: { state: "none", success: 0, failure: 0, pending: 0, checks: [] },
    report: { state: "present" },
    unpublished: 0,
};

function row(): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <ReviewRow
                pr={Pr}
                selected={false}
                marked={false}
                onSelect={vi.fn()}
                onOpen={vi.fn()}
                onValidate={vi.fn()}
                onAskRebase={vi.fn()}
                rebaseAsk={null}
                dir="/p"
                repo="acme/app"
            />
        </Provider>
    );
}

afterEach(() => globalStore.set(ReviewsModel.getInstance().staleAtom, {}));

describe("a card whose hand-off was found out of date (#2145)", () => {
    it("says the state changed, with the head GitHub has", () => {
        expect(row()).not.toContain("reviews-stale-line");
        const stale = rebaseOutcome({ status: "stale", reason: "headmoved", head: Head });
        ReviewsModel.getInstance().noteTask("/p", Pr, "rebase", stale);
        const html = row();
        expect(html).toContain('data-testid="reviews-stale-line"');
        expect(html).toContain("moved on since the card was drawn");
        expect(html).toContain("its head is now 02d4ec6");
    });

    it("says nothing once the card is asked again and an agent has it", () => {
        const model = ReviewsModel.getInstance();
        model.noteTask("/p", Pr, "rebase", rebaseOutcome({ status: "stale", reason: "problemgone", head: Head }));
        model.noteTask("/p", Pr, "rebase", rebaseOutcome({ status: "sent", firstname: "Arthur" }));
        expect(row()).not.toContain("reviews-stale-line");
    });

    it("is the line of that card only", () => {
        ReviewsModel.getInstance().noteTask(
            "/p",
            { ...Pr, number: 2137 },
            "rebase",
            rebaseOutcome({ status: "stale", reason: "prclosed", head: Head })
        );
        expect(row()).not.toContain("reviews-stale-line");
    });
});
