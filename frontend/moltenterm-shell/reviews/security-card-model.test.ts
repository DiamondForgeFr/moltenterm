// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a shared security block says on the cards (FR-REV-036 AC17, #2591): which pull requests it holds and for which scan
// check, the fix in flight or merged that stands for it, the fix's own pull request and what it unblocks.

import { describe, expect, it } from "vitest";
import type { ReviewCheck, ReviewPr, ReviewsAnswer } from "./reviews-model";
import type { SecurityBlock } from "./reviews-security-model";
import {
    cleanCheckName,
    securityCardFacts,
    securityCoversFailing,
    securityFixRef,
    securityFixTarget,
    securityScanChecks,
    securityUnblockFirst,
} from "./security-card-model";
import type { SecurityFix, SecurityFixState } from "./security-fix-model";

const Scan = "Dependency security / Scan dependencies";

function pr(number: number, securityblock?: string, extra: Partial<ReviewPr> = {}): ReviewPr {
    return { number, securityblock, ...extra } as ReviewPr;
}

const Block: SecurityBlock = {
    fingerprint: "aaaa",
    check: Scan,
    origin: "declared",
    source: "report",
    advisories: [{ id: "GO-2026-9101" }, { id: "GHSA-xxxx-0000-yyyy" }],
    trunkfailing: true,
    shared: true,
    prs: [
        { number: 4102, checks: [Scan], shared: true, reasons: ["trunk"] },
        { number: 4105, checks: [Scan], shared: true, reasons: ["prs"] },
        { number: 4107, checks: [Scan], shared: false },
    ],
};

function fix(state: SecurityFixState, over: Partial<SecurityFix> = {}): SecurityFix {
    return {
        fingerprint: "aaaa",
        ids: ["GO-2026-9101", "GHSA-xxxx-0000-yyyy"],
        dir: "/p",
        state,
        startedat: 1000,
        updatedat: 2000,
        ...over,
    };
}

function answer(fixes: SecurityFix[], over: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return {
        dir: "/p",
        ready: [pr(4102, "aaaa"), pr(4105, "aaaa"), pr(4107, "aaaa"), pr(4099)],
        drafts: [pr(4110)],
        securityblocks: [Block],
        securityfixes: fixes,
        ...over,
    } as ReviewsAnswer;
}

describe("a check's name as the block names it", () => {
    it("is kept on one short line, as wavesrv keeps it", () => {
        expect(cleanCheckName("  Dependency   security /\tScan `dependencies`  ")).toBe(Scan);
        expect(cleanCheckName("a<b>c")).toBe("abc");
        const long = "x".repeat(100);
        expect(cleanCheckName(long)).toBe(`${"x".repeat(80)}…`);
        expect(cleanCheckName(undefined)).toBe("");
    });
});

describe("what the answer says of each pull request", () => {
    it("holds a pull request whose failed scan is shared, with the fix in flight that stands for it", () => {
        const working = fix("working", { pr: 4110, ticket: 4109 });
        const facts = securityCardFacts(answer([working]));
        expect(facts[4102].blocked).toEqual({
            fingerprint: "aaaa",
            checks: [Scan],
            reasons: ["trunk"],
            fix: working,
            merged: null,
        });
        expect(facts[4105].blocked.reasons).toEqual(["prs"]);
    });

    it("says nothing of a pull request that brought the advisory itself", () => {
        expect(securityCardFacts(answer([]))[4107]).toBeUndefined();
        expect(securityCardFacts(answer([]))[4099]).toBeUndefined();
    });

    it("has no fix in flight to show when none stands for the block, or it ended", () => {
        expect(securityCardFacts(answer([]))[4102].blocked.fix).toBeNull();
        for (const state of ["stopped", "failed"] as const) {
            expect(securityCardFacts(answer([fix(state)]))[4102].blocked.fix).toBeNull();
        }
    });

    it("keeps a fix that merged lately apart: the pull request waits to be read again", () => {
        const merged = fix("merged", { pr: 4110, mergedat: 5000 });
        const blocked = securityCardFacts(answer([merged]))[4102].blocked;
        expect(blocked.fix).toBeNull();
        expect(blocked.merged).toBe(merged);
    });

    it("gives the fix's own pull request what its merge unblocks, the block's shared ones and not itself", () => {
        const facts = securityCardFacts(answer([fix("ready", { pr: 4110, ticket: 4109 })]));
        expect(facts[4110].own.unblocks).toEqual([4102, 4105]);
        expect(facts[4110].blocked).toBeUndefined();
    });

    it("gives no pull request to a fix that has none yet, nor to one that ended", () => {
        expect(Object.keys(securityCardFacts(answer([fix("working")])))).not.toContain("0");
        const merged = securityCardFacts(answer([fix("merged", { pr: 4110 })]));
        expect(merged[4110]).toBeUndefined();
    });

    it("is the same object for the same answer, which every card asks for", () => {
        const a = answer([fix("working", { pr: 4110 })]);
        expect(securityCardFacts(a)).toBe(securityCardFacts(a));
        expect(securityCardFacts(null)).toEqual({});
    });
});

describe("the failed checks the block covers", () => {
    const failed = (...names: string[]): ReviewCheck[] => names.map((name) => ({ name, state: "failure" }));
    const facts = securityCardFacts(answer([fix("working", { pr: 4110 })]))[4102];

    it("covers a pull request whose only failed check is the scan", () => {
        expect(securityCoversFailing(facts, failed(Scan))).toBe(true);
        expect(securityScanChecks(facts, failed(Scan))).toHaveLength(1);
    });

    it("does not cover one that fails something else too", () => {
        expect(securityCoversFailing(facts, failed(Scan, "Backend"))).toBe(false);
        expect(securityScanChecks(facts, failed(Scan, "Backend")).map((c) => c.name)).toEqual([Scan]);
    });

    it("covers nothing when nothing failed, or the pull request is in no block", () => {
        expect(securityCoversFailing(facts, [])).toBe(false);
        expect(securityCoversFailing(undefined, failed(Scan))).toBe(false);
        expect(securityScanChecks(undefined, failed(Scan))).toEqual([]);
    });

    it("reads a check's name the way the block cleaned it", () => {
        expect(securityCoversFailing(facts, failed(`  Dependency security /   Scan dependencies `))).toBe(true);
    });
});

describe("where the fix is to be found", () => {
    it("is its pull request, else its ticket, else nowhere yet", () => {
        expect(securityFixRef(fix("ready", { pr: 4110, prurl: "https://x/pull/4110", ticket: 4109 }))).toEqual({
            number: 4110,
            kind: "pr",
            url: "https://x/pull/4110",
        });
        expect(securityFixRef(fix("working", { ticket: 4109, ticketurl: "https://x/issues/4109" }))).toEqual({
            number: 4109,
            kind: "issue",
            url: "https://x/issues/4109",
        });
        expect(securityFixRef(fix("waiting"))).toBeNull();
        expect(securityFixRef(null)).toBeNull();
    });

    it("is a Go to target the card opens", () => {
        expect(securityFixTarget({ number: 4110, kind: "pr", url: "u" })).toEqual({
            number: 4110,
            kind: "pr",
            url: "u",
            state: "open",
            from: "relation",
        });
        expect(securityFixTarget(null)).toBeNull();
    });
});

describe("the fixes that go first in the merge order", () => {
    it("are the pull requests of fixes in flight that unblock something", () => {
        expect(securityUnblockFirst(answer([fix("ready", { pr: 4110 })]))).toEqual({ 4110: [4102, 4105] });
        expect(securityUnblockFirst(answer([fix("working", { pr: 4110 })]))).toEqual({ 4110: [4102, 4105] });
    });

    it("are none when the fix has no pull request, nothing to unblock, or ended", () => {
        expect(securityUnblockFirst(answer([fix("working")]))).toEqual({});
        expect(securityUnblockFirst(answer([fix("ready", { pr: 4110 })], { securityblocks: [] }))).toEqual({});
        expect(securityUnblockFirst(answer([fix("stopped", { pr: 4110 })]))).toEqual({});
    });
});
