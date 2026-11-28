// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import {
    isSharedSecurityPr,
    securityAdvisoryIds,
    securityBlockOfPr,
    securityBlockPr,
    securityOffersOfPr,
    sharedSecurityBlocks,
    sharedSecurityPrNumbers,
    type SecurityBlock,
} from "./reviews-security-model";

function pr(number: number, securityblock?: string): ReviewPr {
    return { number, securityblock } as ReviewPr;
}

const Shared: SecurityBlock = {
    fingerprint: "aaaa",
    check: "Dependency security / Scan dependencies",
    origin: "declared",
    source: "report",
    advisories: [
        { id: "GO-2099-0002", package: "example.com/fake/other" },
        { id: "GO-2099-0001", package: "example.com/fake/lib", fixed: "1.2.4" },
    ],
    trunkfailing: true,
    shared: true,
    prs: [
        { number: 11, checks: ["Dependency security / Scan dependencies"], shared: true, reasons: ["trunk", "prs"] },
        { number: 12, checks: ["Dependency security / Scan dependencies"], shared: false },
    ],
};

const Own: SecurityBlock = {
    fingerprint: "bbbb",
    check: "Dependency security / Scan dependencies",
    origin: "declared",
    source: "log",
    advisories: [{ id: "GHSA-aaaa-bbbb-cccc" }],
    shared: false,
    prs: [{ number: 5, checks: ["Dependency security / Scan dependencies"], shared: false }],
};

function answer(): ReviewsAnswer {
    return {
        dir: "/p",
        ready: [pr(11, "aaaa"), pr(12, "aaaa"), pr(13)],
        drafts: [pr(5, "bbbb"), pr(6, "gone")],
        securityblocks: [Own, Shared],
        securityoffers: [{ check: "Security audit", workflow: "Audit", ids: ["GO-2099-0001"], prs: [13] }],
    };
}

describe("security blocks of the Integration list", () => {
    it("finds the block of a pull request, ready or draft", () => {
        expect(securityBlockOfPr(answer(), 12)?.fingerprint).toBe("aaaa");
        expect(securityBlockOfPr(answer(), 5)?.fingerprint).toBe("bbbb");
    });

    it("finds none for a pull request outside every block, or whose block is not in the answer", () => {
        expect(securityBlockOfPr(answer(), 13)).toBeNull();
        expect(securityBlockOfPr(answer(), 6)).toBeNull();
        expect(securityBlockOfPr(answer(), 99)).toBeNull();
        expect(securityBlockOfPr(null, 11)).toBeNull();
        expect(securityBlockOfPr({ dir: "/p", ready: [pr(11, "aaaa")], drafts: [] }, 11)).toBeNull();
    });

    it("says, for each pull request of a block, whether the failure is its own", () => {
        expect(isSharedSecurityPr(answer(), 11)).toBe(true);
        // the block is shared, but #12 is in it for a reason of its own: it brought an advisory itself
        expect(isSharedSecurityPr(answer(), 12)).toBe(false);
        expect(isSharedSecurityPr(answer(), 5)).toBe(false);
        expect(isSharedSecurityPr(answer(), 13)).toBe(false);
        expect(securityBlockPr(answer(), 11)?.reasons).toEqual(["trunk", "prs"]);
        expect(securityBlockPr(answer(), 13)).toBeNull();
    });

    it("lists the shared blocks and the pull requests their fix unblocks", () => {
        const blocks = sharedSecurityBlocks(answer());
        expect(blocks.map((block) => block.fingerprint)).toEqual(["aaaa"]);
        expect(sharedSecurityPrNumbers(blocks[0])).toEqual([11]);
        expect(sharedSecurityBlocks({ dir: "/p", ready: [], drafts: [] })).toEqual([]);
        expect(sharedSecurityPrNumbers(null)).toEqual([]);
    });

    it("does not reorder the answer when it lists them", () => {
        const a = answer();
        sharedSecurityBlocks(a);
        expect(a.securityblocks?.map((block) => block.fingerprint)).toEqual(["bbbb", "aaaa"]);
    });

    it("names the advisories of a block by id, sorted", () => {
        expect(securityAdvisoryIds(Shared)).toEqual(["GO-2099-0001", "GO-2099-0002"]);
        expect(securityAdvisoryIds(null)).toEqual([]);
    });

    it("finds what is offered for a pull request", () => {
        expect(securityOffersOfPr(answer(), 13).map((offer) => offer.check)).toEqual(["Security audit"]);
        expect(securityOffersOfPr(answer(), 11)).toEqual([]);
    });
});
