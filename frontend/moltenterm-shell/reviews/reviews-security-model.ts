// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The failed dependency or security scans of the Integration list (FR-REV-036): the wire types of the answer's
// securityblocks, securityoffers and securityunread (pkg/molten/secfix, filled by pkg/molten/mission/reviews_security.go)
// and the pure helpers the panel and what follows a shared block read them with. wavesrv does the reading; nothing here
// launches, writes or words anything.

import type { ReviewPr, ReviewsAnswer } from "./reviews-model";

// must match the Reason constants in pkg/molten/secfix/secfix.go
export type SecurityReason = "trunk" | "prs" | "nodependencychange";

// must match the Cause constants in pkg/molten/secfix/advisories.go
export type SecurityCause = "scanner-input-failure" | "report-unreadable" | "log-unreadable" | "no-advisory" | "no-job";

// must match Advisory in pkg/molten/secfix/secfix.go
export type SecurityAdvisory = {
    id: string;
    ecosystem?: string;
    package?: string;
    version?: string;
    fixed?: string;
    severity?: string;
    summary?: string;
};

// must match BlockPr in pkg/molten/secfix/shared.go
export type SecurityBlockPr = {
    number: number;
    // the scan checks of the pull request that failed
    checks: string[];
    // the failure is not the pull request's own; reasons says why
    shared: boolean;
    reasons?: SecurityReason[];
};

// must match Block in pkg/molten/secfix/shared.go
export type SecurityBlock = {
    // keys the set of advisories: one ticket and one fix per fingerprint
    fingerprint: string;
    check: string;
    // "declared" by the project's .molten/project.json, or "confirmed" by the developer once
    origin: "declared" | "confirmed";
    // "report" when every blocked pull request's advisories come from a report, else "log"
    source: "report" | "log";
    advisories: SecurityAdvisory[];
    // the same scan fails on the trunk with advisories of this set, or ones nobody could read
    trunkfailing?: boolean;
    trunkrun?: number;
    // at least one of its pull requests did not cause it
    shared: boolean;
    prs: SecurityBlockPr[];
};

// must match Offer in pkg/molten/secfix/shared.go: a check that looks like the scan, until the developer answers
export type SecurityOffer = { check: string; workflow?: string; ids: string[]; prs: number[] };

// must match Unread in pkg/molten/secfix/shared.go: a failed scan whose advisories could not be read
export type SecurityUnread = { pr: number; checks: string[]; cause: SecurityCause };

// must match the Answer constants in pkg/molten/secfix/store.go
export type SecurityScanAnswer = "confirm" | "dismiss" | "reset";

export function securityBlockOfPr(answer: ReviewsAnswer, number: number): SecurityBlock {
    const pr = [...(answer?.ready ?? []), ...(answer?.drafts ?? [])].find((p: ReviewPr) => p.number === number);
    if (pr?.securityblock == null) {
        return null;
    }
    return (answer.securityblocks ?? []).find((block) => block.fingerprint === pr.securityblock) ?? null;
}

// The entry of a pull request in its block; null when it is in none.
export function securityBlockPr(answer: ReviewsAnswer, number: number): SecurityBlockPr {
    return securityBlockOfPr(answer, number)?.prs.find((pr) => pr.number === number) ?? null;
}

// Whether the pull request's failed scan is not its own: the trunk fails the same way, another pull request fails on one
// of its advisories, or it changes no dependency file.
export function isSharedSecurityPr(answer: ReviewsAnswer, number: number): boolean {
    return securityBlockPr(answer, number)?.shared === true;
}

// The blocks at least one pull request of which did not cause, the first pull request's number first.
export function sharedSecurityBlocks(answer: ReviewsAnswer): SecurityBlock[] {
    return (answer?.securityblocks ?? [])
        .filter((block) => block.shared)
        .sort((a, b) => (a.prs[0]?.number ?? 0) - (b.prs[0]?.number ?? 0));
}

// The pull requests of a block that did not cause it: the ones its fix unblocks.
export function sharedSecurityPrNumbers(block: SecurityBlock): number[] {
    return (block?.prs ?? []).filter((pr) => pr.shared).map((pr) => pr.number);
}

export function securityAdvisoryIds(block: SecurityBlock): string[] {
    return (block?.advisories ?? []).map((advisory) => advisory.id).sort();
}

// The checks the developer is asked about once, for the pull request: a check that looks like the scan.
export function securityOffersOfPr(answer: ReviewsAnswer, number: number): SecurityOffer[] {
    return (answer?.securityoffers ?? []).filter((offer) => offer.prs.includes(number));
}
