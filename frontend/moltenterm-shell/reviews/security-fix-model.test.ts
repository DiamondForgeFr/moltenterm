// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import type { SecurityBlock } from "./reviews-security-model";
import {
    isSecurityBlockFixable,
    isSecurityFixInFlight,
    isSecurityFixStoppable,
    mergedSecurityFixes,
    securityFixBlocks,
    securityFixConsentOf,
    securityFixConsentWrites,
    securityFixCoveringPr,
    securityFixCovers,
    securityFixOfBlock,
    securityFixUnblocks,
    type SecurityFix,
    type SecurityFixState,
} from "./security-fix-model";

function pr(number: number, securityblock?: string): ReviewPr {
    return { number, securityblock } as ReviewPr;
}

const Block: SecurityBlock = {
    fingerprint: "aaaa",
    check: "Dependency security / Scan dependencies",
    origin: "declared",
    source: "report",
    advisories: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "GO-2026-1" }],
    trunkfailing: true,
    shared: true,
    prs: [
        { number: 11, checks: ["Dependency security / Scan dependencies"], shared: true, reasons: ["trunk"] },
        { number: 12, checks: ["Dependency security / Scan dependencies"], shared: true, reasons: ["prs"] },
        { number: 13, checks: ["Dependency security / Scan dependencies"], shared: false },
    ],
};

function fix(state: SecurityFixState, over: Partial<SecurityFix> = {}): SecurityFix {
    return {
        fingerprint: "aaaa",
        ids: ["GHSA-aaaa-bbbb-cccc", "GO-2026-1"],
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
        ready: [pr(11, "aaaa"), pr(12, "aaaa"), pr(13, "aaaa"), pr(14)],
        drafts: [pr(150)],
        securityblocks: [Block],
        securityfixes: fixes,
        ...over,
    } as ReviewsAnswer;
}

describe("the developer's consent to start a security fix on its own (FR-REV-036 AC10)", () => {
    const confirmed = { "molten:securityfix": 1_700_000_000_000 };

    it("is unasked until the setting is written, off when it is false, on only with the confirmation", () => {
        expect(securityFixConsentOf(undefined, {})).toBe("unasked");
        expect(securityFixConsentOf(null, confirmed)).toBe("unasked");
        expect(securityFixConsentOf(false, confirmed)).toBe("off");
        expect(securityFixConsentOf(true, confirmed)).toBe("on");
    });

    it("never takes the setting alone, nor a forged confirmation, for a consent", () => {
        expect(securityFixConsentOf(true, {})).toBe("off");
        expect(securityFixConsentOf(true, undefined)).toBe("off");
        expect(securityFixConsentOf(true, { "molten:securityfix": true })).toBe("off");
        expect(securityFixConsentOf(true, { "molten:securityfix": "yes" })).toBe("off");
        expect(securityFixConsentOf(true, { "molten:securityfix": 0 })).toBe("off");
        expect(securityFixConsentOf(true, { "molten:securityfix": null })).toBe("off");
    });

    it("writes the confirmation and the setting together, and the answer 'only when asked' takes both back", () => {
        expect(securityFixConsentWrites("always", 1234)).toEqual({
            clientMeta: { "molten:securityfix": 1234 },
            settings: { "review:securityfix": true },
        });
        expect(securityFixConsentWrites("ask", 1234)).toEqual({
            clientMeta: { "molten:securityfix": null },
            settings: { "review:securityfix": false },
        });
        const writes = securityFixConsentWrites("always", 1234);
        expect(securityFixConsentOf(writes.settings["review:securityfix"], writes.clientMeta)).toBe("on");
        const asked = securityFixConsentWrites("ask", 1234);
        expect(securityFixConsentOf(asked.settings["review:securityfix"], asked.clientMeta)).toBe("off");
    });
});

describe("the fix that stands for a block (FR-REV-036 AC9, AC17)", () => {
    it("is the one in flight, whatever it is told apart from by its fingerprint", () => {
        const working = fix("working");
        expect(securityFixOfBlock(answer([working]), Block)).toBe(working);
        expect(securityFixOfBlock(answer([]), Block)).toBeNull();
        expect(securityFixOfBlock(answer([working]), null)).toBeNull();
        // a fix of another set does not stand for it
        expect(
            securityFixOfBlock(answer([fix("working", { fingerprint: "zzzz", ids: ["CVE-2026-9"] })]), Block)
        ).toBeNull();
    });

    it("keeps standing for the block once an advisory joined its set, and prefers the fix in flight to the one that ended", () => {
        const grown = fix("working", { fingerprint: "zzzz", ids: ["GHSA-aaaa-bbbb-cccc", "GO-2026-1", "CVE-2026-9"] });
        expect(securityFixOfBlock(answer([grown]), Block)).toBe(grown);
        const stopped = fix("stopped", { updatedat: 9000 });
        expect(securityFixOfBlock(answer([stopped, grown]), Block)).toBe(grown);
        const older = fix("merged", { updatedat: 1 });
        expect(securityFixOfBlock(answer([older, stopped]), Block)).toBe(stopped);
    });

    it("covers the advisories of its set and the ones that joined it", () => {
        const f = fix("working", { extra: ["CVE-2026-9"] });
        expect(securityFixCovers(f, ["GO-2026-1"])).toBe(true);
        expect(securityFixCovers(f, ["GO-2026-1", "CVE-2026-9"])).toBe(true);
        expect(securityFixCovers(f, ["CVE-2026-8"])).toBe(false);
        expect(securityFixCovers(f, [])).toBe(false);
        expect(securityFixCovers(null, ["GO-2026-1"])).toBe(false);
    });

    it("says what is in flight and what the developer can stop", () => {
        for (const state of ["waiting", "working", "needsyou", "ready"] as SecurityFixState[]) {
            expect(isSecurityFixInFlight(fix(state))).toBe(true);
            expect(isSecurityFixStoppable(fix(state))).toBe(true);
        }
        for (const state of ["merged", "stopped", "failed"] as SecurityFixState[]) {
            expect(isSecurityFixInFlight(fix(state))).toBe(false);
            expect(isSecurityFixStoppable(fix(state))).toBe(false);
        }
        expect(isSecurityFixInFlight(fix("working", { external: true }))).toBe(true);
        expect(isSecurityFixStoppable(fix("working", { external: true }))).toBe(false);
    });
});

describe("what the panel reads of a fix", () => {
    it("names the pull requests its merge unblocks: the block's, but the ones that brought the advisory and the fix's own", () => {
        expect(securityFixUnblocks(answer([fix("ready", { pr: 150 })]), fix("ready", { pr: 150 }))).toEqual([11, 12]);
        expect(securityFixUnblocks(answer([]), null)).toEqual([]);
        expect(securityFixUnblocks({ dir: "/p", ready: [], drafts: [] }, fix("ready"))).toEqual([]);
        const inBlock = fix("ready", { pr: 11 });
        expect(securityFixUnblocks(answer([inBlock]), inBlock)).toEqual([12]);
        // The merge turned them green and the block left the answer: what the fix kept stands.
        const merged = fix("merged", { pr: 150, unblocks: [11, 12] });
        expect(securityFixUnblocks(answer([merged], { securityblocks: [] }), merged)).toEqual([11, 12]);
    });

    it("finds the fix in flight that covers a pull request whose failure is not its own", () => {
        const working = fix("working");
        expect(securityFixCoveringPr(answer([working]), 11)).toBe(working);
        // #13 brought an advisory itself: its failure is its own, the fix does not stand for it
        expect(securityFixCoveringPr(answer([working]), 13)).toBeNull();
        expect(securityFixCoveringPr(answer([working]), 14)).toBeNull();
        expect(securityFixCoveringPr(answer([fix("stopped")]), 11)).toBeNull();
        expect(securityFixCoveringPr(answer([]), 11)).toBeNull();
        expect(securityFixCoveringPr(null, 11)).toBeNull();
    });

    it("offers a block once: declared or confirmed, shared, and no fix in flight (a stopped one starts only on a click)", () => {
        expect(isSecurityBlockFixable(answer([]), Block)).toBe(true);
        expect(isSecurityBlockFixable(answer([fix("stopped")]), Block)).toBe(true);
        expect(isSecurityBlockFixable(answer([fix("failed")]), Block)).toBe(true);
        expect(isSecurityBlockFixable(answer([fix("merged")]), Block)).toBe(true);
        expect(isSecurityBlockFixable(answer([fix("working")]), Block)).toBe(false);
        expect(isSecurityBlockFixable(answer([fix("ready")]), Block)).toBe(false);
        expect(isSecurityBlockFixable(answer([]), { ...Block, shared: false })).toBe(false);
        expect(isSecurityBlockFixable(answer([]), { ...Block, origin: "" as any })).toBe(false);
        expect(isSecurityBlockFixable(answer([]), null)).toBe(false);
    });

    it("lists the shared blocks with the fix of each, and the fixes that merged", () => {
        const own: SecurityBlock = { ...Block, fingerprint: "bbbb", shared: false };
        const merged = fix("merged");
        const rows = securityFixBlocks(answer([merged], { securityblocks: [own, Block] }));
        expect(rows).toHaveLength(1);
        expect(rows[0].block).toBe(Block);
        expect(rows[0].fix).toBe(merged);
        expect(mergedSecurityFixes(answer([merged, fix("working", { fingerprint: "zzzz" })]))).toEqual([merged]);
        expect(securityFixBlocks(null)).toEqual([]);
    });
});
