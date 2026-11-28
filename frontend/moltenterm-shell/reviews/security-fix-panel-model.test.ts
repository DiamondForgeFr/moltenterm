// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The security fix block at the top of the Integration list (FR-REV-036 AC17, #2591): which blocks the panel shows, in which
// step, and which of them holds the panel's one filled button.

import { describe, expect, it } from "vitest";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import type { SecurityBlock } from "./reviews-security-model";
import type { SecurityFix, SecurityFixState } from "./security-fix-model";
import {
    mergedFixKey,
    securityFilledBlock,
    securityFixBlockViews,
    SecurityFixMergedShownMs,
    securityUnblockOutcomes,
    securityUnblockRows,
} from "./security-fix-panel-model";

const Scan = "Dependency security / Scan dependencies";
const Now = 10 * SecurityFixMergedShownMs;

function pr(number: number, securityblock?: string, extra: Partial<ReviewPr> = {}): ReviewPr {
    return { number, securityblock, ...extra } as ReviewPr;
}

const Block: SecurityBlock = {
    fingerprint: "aaaa",
    check: Scan,
    origin: "declared",
    source: "report",
    advisories: [
        { id: "GO-2026-9101", package: "go.exemple.io/telemetrie", version: "1.4.0", fixed: "1.7.0" },
        { id: "GHSA-xxxx-0000-yyyy", ecosystem: "npm", package: "exemple-parser", version: "2.1.0", fixed: "2.1.3" },
    ],
    trunkfailing: true,
    shared: true,
    prs: [
        { number: 4102, checks: [Scan], shared: true, reasons: ["trunk"] },
        { number: 4105, checks: [Scan], shared: true, reasons: ["trunk"] },
        { number: 4107, checks: [Scan], shared: true, reasons: ["trunk"] },
    ],
};

function fix(state: SecurityFixState, over: Partial<SecurityFix> = {}): SecurityFix {
    return {
        fingerprint: "aaaa",
        ids: ["GO-2026-9101", "GHSA-xxxx-0000-yyyy"],
        dir: "/p",
        state,
        startedat: Now - 1000,
        updatedat: Now - 500,
        ...over,
    };
}

function answer(fixes: SecurityFix[], over: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return {
        dir: "/p",
        ready: [pr(4102, "aaaa"), pr(4105, "aaaa"), pr(4107, "aaaa"), pr(4099)],
        drafts: [pr(4110, undefined, { draft: true })],
        securityblocks: [Block],
        securityfixes: fixes,
        ...over,
    } as ReviewsAnswer;
}

const views = (a: ReviewsAnswer, consent: "unasked" | "off" | "on" = "unasked") =>
    securityFixBlockViews(a, consent, Now);

describe("the first-time ask, when no fix stands for a shared block (mockup step 1)", () => {
    it("is one block with its advisories and the pull requests it holds, which needs the developer", () => {
        const [view] = views(answer([]));
        expect(view).toMatchObject({
            key: "aaaa",
            step: "ask",
            consent: "unasked",
            prs: [4102, 4105, 4107],
            fix: null,
            pr: null,
            needsYou: true,
        });
        expect(view.advisories.map((a) => a.id)).toEqual(["GO-2026-9101", "GHSA-xxxx-0000-yyyy"]);
        expect(securityFilledBlock(views(answer([])))).toBe("aaaa");
    });

    it("carries what the developer said about starting it on its own, to word the ask", () => {
        expect(views(answer([]), "off")[0].consent).toBe("off");
        expect(views(answer([]), "on")[0].consent).toBe("on");
    });

    it("shows no block for a failure no pull request left to someone else: only a shared block is the panel's", () => {
        const own = { ...Block, shared: false, prs: Block.prs.map((p) => ({ ...p, shared: false })) };
        expect(views(answer([], { securityblocks: [own] }))).toEqual([]);
        expect(views(answer([], { securityblocks: [] }))).toEqual([]);
        expect(securityFilledBlock([])).toBeNull();
    });

    it("leaves for now when the developer puts it off, and only the ask", () => {
        const later = { later: (key: string) => key === "aaaa", dismissed: () => false };
        expect(securityFixBlockViews(answer([]), "unasked", Now, later)).toEqual([]);
        expect(securityFixBlockViews(answer([fix("working")]), "unasked", Now, later)).toHaveLength(1);
    });

    it("says a block with no pull request: the scan blocks the trunk (a red trunk, AC16)", () => {
        const trunkOnly = { ...Block, prs: [] };
        const [view] = views(answer([], { securityblocks: [trunkOnly], ready: [], drafts: [] }));
        expect(view.step).toBe("ask");
        expect(view.prs).toEqual([]);
    });
});

describe("the fix at work, waiting, needing the developer (mockup step 2)", () => {
    it("works: its pull request and the ones it will unblock, nothing for the developer to do", () => {
        const [view] = views(answer([fix("working", { pr: 4110, ticket: 4109, auto: true })]));
        expect(view.step).toBe("working");
        expect(view.prs).toEqual([4102, 4105, 4107]);
        expect(view.pr?.number).toBe(4110);
        expect(view.needsYou).toBe(false);
        expect(securityFilledBlock([view])).toBeNull();
    });

    it("waits for a place without needing the developer", () => {
        const [view] = views(answer([fix("waiting", { reason: "machinebusy" })]));
        expect(view.step).toBe("waiting");
        expect(view.needsYou).toBe(false);
    });

    it("needs the developer when its agent or MoltenTerm waits for them", () => {
        const [view] = views(answer([fix("needsyou", { reason: "outcome", outcome: "needs you: no fixed version" })]));
        expect(view.step).toBe("needsyou");
        expect(view.needsYou).toBe(true);
    });

    it("keeps the fix's own pull request out of what it unblocks", () => {
        const block = {
            ...Block,
            prs: [...Block.prs, { number: 4110, checks: [Scan], shared: true, reasons: ["trunk" as const] }],
        };
        const [view] = views(answer([fix("working", { pr: 4110 })], { securityblocks: [block] }));
        expect(view.prs).toEqual([4102, 4105, 4107]);
    });
});

describe("the fix ready to merge (mockup step 3)", () => {
    it("is the panel's one filled action, with the pull request that merges and the ones it unblocks", () => {
        const [view] = views(answer([fix("ready", { pr: 4110, ticket: 4109 })]));
        expect(view).toMatchObject({ step: "ready", needsYou: true, prs: [4102, 4105, 4107] });
        expect(view.pr?.number).toBe(4110);
        expect(securityFilledBlock([view])).toBe("aaaa");
    });

    it("has no pull request to merge from the panel when the list does not hold it", () => {
        const [view] = views(answer([fix("ready", { pr: 4999 })]));
        expect(view.pr).toBeNull();
    });
});

describe("a fix that ended", () => {
    it("stopped by the developer is shown calm, to be launched again on a click", () => {
        const [view] = views(answer([fix("stopped")]));
        expect(view).toMatchObject({ step: "stopped", needsYou: false });
    });

    it("failed needs the developer: nothing started it again on its own", () => {
        const [view] = views(answer([fix("failed", { reason: "noagent" })]));
        expect(view).toMatchObject({ step: "failed", needsYou: true });
    });
});

describe("one filled button for the whole panel", () => {
    it("goes to the first block that needs the developer, the others stay calm", () => {
        const other: SecurityBlock = {
            ...Block,
            fingerprint: "bbbb",
            prs: [{ number: 4300, checks: [Scan], shared: true }],
        };
        const a = answer([], {
            securityblocks: [Block, other],
            ready: [pr(4102, "aaaa"), pr(4300, "bbbb")],
        });
        const list = views(a);
        expect(list.map((v) => [v.key, v.needsYou])).toEqual([
            ["aaaa", true],
            ["bbbb", false],
        ]);
        expect(securityFilledBlock(list)).toBe("aaaa");
    });

    it("skips a block at work to give it to the next that needs the developer", () => {
        const other: SecurityBlock = { ...Block, fingerprint: "bbbb", advisories: [{ id: "GO-2026-1" }], prs: [] };
        const list = views(answer([fix("working")], { securityblocks: [Block, other], ready: [], drafts: [] }));
        expect(list.map((v) => [v.key, v.step, v.needsYou])).toEqual([
            ["aaaa", "working", false],
            ["bbbb", "ask", true],
        ]);
    });
});

describe("after the merge (mockup step 4)", () => {
    const merged = (over: Partial<SecurityFix> = {}) =>
        fix("merged", { pr: 4110, mergedat: Now - 60_000, unblocks: [4102, 4105, 4107], ...over });

    it("says what the merge unblocked while the block is still there", () => {
        const [view] = views(answer([merged()]));
        expect(view).toMatchObject({ step: "merged", needsYou: false, prs: [4102, 4105, 4107] });
    });

    it("says it once the scan is green again and the block is gone, from what the fix kept", () => {
        const [view] = views(answer([merged()], { securityblocks: [], ready: [pr(4102), pr(4105), pr(4107)] }));
        expect(view).toMatchObject({ step: "merged", block: null, key: "aaaa", prs: [4102, 4105, 4107] });
        expect(view.advisories.map((a) => a.id)).toEqual(["GO-2026-9101", "GHSA-xxxx-0000-yyyy"]);
    });

    it("hides when the developer hid it, and shows again for a later fix of the same advisories", () => {
        const hidden = { later: () => false, dismissed: (key: string) => key === mergedFixKey(merged()) };
        expect(securityFixBlockViews(answer([merged()]), "unasked", Now, hidden)).toEqual([]);
        expect(
            securityFixBlockViews(answer([merged({ mergedat: Now - 30_000 })]), "unasked", Now, hidden)
        ).toHaveLength(1);
    });

    it("shows nothing when the merge unblocked nothing", () => {
        const nothing = merged({ unblocks: [] });
        expect(views(answer([nothing], { securityblocks: [], ready: [], drafts: [] }))).toEqual([]);
    });

    it("lets go after three hours, as wavesrv does: a block still there asks again", () => {
        const old = merged({ mergedat: Now - SecurityFixMergedShownMs - 1 });
        expect(views(answer([old]))[0]).toMatchObject({ step: "ask", fix: null });
        expect(views(answer([old], { securityblocks: [] }))).toEqual([]);
    });

    it("is remembered by the fix and the time it merged", () => {
        expect(mergedFixKey(merged({ mergedat: 7 }))).toBe("aaaa:7");
        expect(mergedFixKey(fix("merged", { updatedat: 9 }))).toBe("aaaa:9");
    });
});

describe("what became of each pull request the merge unblocked", () => {
    const merged = fix("merged", { pr: 4110, mergedat: Now, unblocks: [4102, 4105, 4107, 4120] });
    const checks = (state: "success" | "failure" | "pending") => ({
        state,
        success: state === "success" ? 4 : 3,
        failure: state === "failure" ? 1 : 0,
        pending: state === "pending" ? 1 : 0,
        checks: [],
    });
    const list = answer([merged], {
        securityblocks: [],
        ready: [
            pr(4102, undefined, { ci: checks("pending") }),
            pr(4105, undefined, { ci: checks("success") }),
            pr(4107, "aaaa", { ci: checks("failure") }),
        ],
        drafts: [],
    });

    it("reads each one's checks from the list: running, passed, still waiting to be brought onto the trunk, gone", () => {
        expect(securityUnblockRows(list, merged).map((r) => [r.pr, r.progress])).toEqual([
            [4102, "running"],
            [4105, "green"],
            [4107, "waiting"],
            [4120, "gone"],
        ]);
    });

    it("tells a pull request that fails something else apart from one still on the old head", () => {
        const elsewhere = answer([merged], {
            securityblocks: [],
            ready: [pr(4102, undefined, { ci: checks("failure") })],
        });
        expect(securityUnblockRows(elsewhere, merged)[0].progress).toBe("red");
    });

    it("takes what the unblock step recorded, when it recorded something (the data hook of #2590)", () => {
        expect(securityUnblockOutcomes(list, merged)).toEqual([]);
        const rows = securityUnblockRows(list, merged, [
            { pr: 4105, how: "handed", agent: "Bastien" },
            { pr: 4102, how: "updated" },
        ]);
        expect(rows[0]).toMatchObject({ pr: 4102, progress: "running", outcome: { how: "updated" } });
        expect(rows[1].outcome).toEqual({ pr: 4105, how: "handed", agent: "Bastien" });
        expect(rows[2].outcome).toBeUndefined();
    });

    it("has no rows for a fix that kept nothing", () => {
        expect(securityUnblockRows(list, fix("merged"))).toEqual([]);
        expect(securityUnblockRows(null, null)).toEqual([]);
    });
});
