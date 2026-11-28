// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a shared security block says on the cards of the Integration panel (FR-REV-036 AC15 to AC17, FR-REV-001): the
// pull requests whose failed dependency scan is not their own, and the pull request of a security fix. Pure, from the
// answer: the card state (reviews-card-model.ts), the merge order (reviews-queue-model.ts) and the sidebar's counts read
// the same facts, so a card is counted in the section it is listed in.

import type { ReviewCheck, ReviewDependency, ReviewPr, ReviewsAnswer } from "./reviews-model";
import type { SecurityReason } from "./reviews-security-model";
import {
    isSecurityFixInFlight,
    securityFixesOf,
    securityFixOfBlock,
    securityFixUnblocks,
    type SecurityFix,
} from "./security-fix-model";

// The failed scan of a pull request, when it belongs to a shared block.
export type SecurityBlockedFacts = {
    fingerprint: string;
    // The scan checks that failed on the pull request, as the block names them (cleaned as wavesrv cleans them).
    checks: string[];
    // Why the failure is not the pull request's own.
    reasons: SecurityReason[];
    // The fix in flight that stands for the block; null when none does and the block asks the developer.
    fix: SecurityFix;
    // The fix of the block that merged lately: the pull request waits to be read again on the fixed trunk.
    merged: SecurityFix;
};

// The pull request is a security fix's own, in flight.
export type SecurityOwnFacts = { fix: SecurityFix; unblocks: number[] };

export type SecurityCardFacts = { blocked?: SecurityBlockedFacts; own?: SecurityOwnFacts };

// How wavesrv keeps a check's name on one short line (secfix.CleanLine, 80): the block names the checks that way.
export function cleanCheckName(name: string): string {
    const clean = (name ?? "")
        .replace(/[`<>]/g, "")
        .replace(/[\p{Cc}\s]+/gu, " ")
        .trim();
    const runes = [...clean];
    return runes.length > 80 ? `${runes.slice(0, 80).join("").trim()}…` : clean;
}

const FactsCache = new WeakMap<ReviewsAnswer, Record<number, SecurityCardFacts>>();

// securityCardFacts: by pull request number, what the answer's blocks and fixes say of each pull request. Kept by answer,
// since every card asks for it.
export function securityCardFacts(answer: ReviewsAnswer): Record<number, SecurityCardFacts> {
    if (answer == null) {
        return {};
    }
    const known = FactsCache.get(answer);
    if (known != null) {
        return known;
    }
    const rtn: Record<number, SecurityCardFacts> = {};
    const prs: ReviewPr[] = [...(answer.ready ?? []), ...(answer.drafts ?? [])];
    for (const pr of prs) {
        if (pr.securityblock == null) {
            continue;
        }
        const block = (answer.securityblocks ?? []).find((b) => b.fingerprint === pr.securityblock);
        const entry = block?.prs.find((p) => p.number === pr.number);
        if (block == null || entry == null || !entry.shared) {
            continue;
        }
        const fix = securityFixOfBlock(answer, block);
        rtn[pr.number] = {
            blocked: {
                fingerprint: block.fingerprint,
                checks: entry.checks ?? [],
                reasons: entry.reasons ?? [],
                fix: fix != null && isSecurityFixInFlight(fix) ? fix : null,
                merged: fix?.state === "merged" ? fix : null,
            },
        };
    }
    for (const fix of securityFixesOf(answer)) {
        if (fix.pr == null || fix.pr <= 0 || !isSecurityFixInFlight(fix)) {
            continue;
        }
        rtn[fix.pr] = { ...rtn[fix.pr], own: { fix, unblocks: securityFixUnblocks(answer, fix) } };
    }
    FactsCache.set(answer, rtn);
    return rtn;
}

// Whether every failed check of the pull request is a scan check of its shared block: nothing else fails on it, so the
// block says all there is to say, and nothing is the developer's to do on the card itself.
export function securityCoversFailing(facts: SecurityCardFacts, failed: readonly ReviewCheck[]): boolean {
    const blocked = facts?.blocked;
    if (blocked == null || failed.length === 0) {
        return false;
    }
    return failed.every((check) => blocked.checks.includes(cleanCheckName(check.name)));
}

// The failed checks of the pull request that belong to its shared block.
export function securityScanChecks(facts: SecurityCardFacts, failed: readonly ReviewCheck[]): ReviewCheck[] {
    const blocked = facts?.blocked;
    if (blocked == null) {
        return [];
    }
    return failed.filter((check) => blocked.checks.includes(cleanCheckName(check.name)));
}

// Where a fix is to be found: its pull request, else its ticket (an issue, which opens on GitHub), else nowhere yet (it
// waits for a place, or its agent has not opened anything).
export type SecurityFixRef = { number: number; kind: "pr" | "issue"; url?: string };

export function securityFixRef(fix: SecurityFix): SecurityFixRef {
    if (fix == null) {
        return null;
    }
    if (fix.pr != null && fix.pr > 0) {
        return { number: fix.pr, kind: "pr", url: fix.prurl };
    }
    if (fix.ticket != null && fix.ticket > 0) {
        return { number: fix.ticket, kind: "issue", url: fix.ticketurl };
    }
    return null;
}

// The card's "Go to #N" target for a ref.
export function securityFixTarget(ref: SecurityFixRef): ReviewDependency {
    return ref == null ? null : { number: ref.number, kind: ref.kind, url: ref.url, state: "open", from: "relation" };
}

// The fix pull requests in the merge order's first place, by number, with the pull requests their merge unblocks: a
// fix in flight with a pull request and something to unblock. The order puts them before the others (FR-REV-036 AC15).
export function securityUnblockFirst(answer: ReviewsAnswer): Record<number, number[]> {
    const rtn: Record<number, number[]> = {};
    for (const [number, facts] of Object.entries(securityCardFacts(answer))) {
        if (facts.own != null && facts.own.unblocks.length > 0) {
            rtn[Number(number)] = facts.own.unblocks;
        }
    }
    return rtn;
}
