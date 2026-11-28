// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The security fix block at the top of the Integration list (FR-REV-036 AC17, #2591): which blocks the panel shows, in which
// of its steps, with what, and which of them holds the panel's one filled button. Pure, from the answer (securityblocks and
// securityfixes, #2588 and #2589): wavesrv starts, follows and stops the fix, this only says what to draw.
// The steps are the mockup's four (the first-time ask, working, ready to merge, after the merge) and the ones a fix has
// that the mockup does not draw: it waits for a place, it needs the developer, it was stopped, it failed.

import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import { sharedSecurityPrNumbers, type SecurityAdvisory, type SecurityBlock } from "./reviews-security-model";
import {
    mergedSecurityFixes,
    securityFixOfBlock,
    securityFixUnblocks,
    type SecurityFix,
    type SecurityFixConsent,
} from "./security-fix-model";

// How long a merged fix still stands for its advisories, and the panel says what its merge unblocked: the scan on the trunk
// turns green only after its own run. Must match mergedCovers in pkg/molten/secfix/fix.go.
export const SecurityFixMergedShownMs = 3 * 60 * 60 * 1000;

// ask: no fix stands for the block (the developer launches it; the first time, the ask is three buttons); waiting: it waits
// for a place for its agent; working: its agent works; needsyou: the agent or MoltenTerm waits for the developer; ready: its
// pull request can be merged; merged: it landed and the blocked pull requests resume; stopped and failed: it ended, and is
// never started again on its own.
export type SecurityBlockStep = "ask" | "waiting" | "working" | "needsyou" | "ready" | "merged" | "stopped" | "failed";

export type SecurityFixBlockView = {
    // The block's fingerprint (a merged fix's own, once the block is gone): what "See the alert" brings into view.
    key: string;
    step: SecurityBlockStep;
    consent: SecurityFixConsent;
    // Null once the scan is green again and only the merged fix is left to tell.
    block: SecurityBlock;
    fix: SecurityFix;
    advisories: SecurityAdvisory[];
    // The pull requests the block holds (ask), or the ones the fix's merge unblocks (the other steps), by PR number.
    prs: number[];
    // The fix's own pull request, as the list holds it.
    pr: ReviewPr;
    // The developer is needed: it takes the panel's filled button.
    needsYou: boolean;
};

// What the developer can still hide: the ask ("Later") and what the merge unblocked ("Hide").
export type SecurityFixHidden = { later: (key: string) => boolean; dismissed: (key: string) => boolean };

const NothingHidden: SecurityFixHidden = { later: () => false, dismissed: () => false };

const NeedsYou = new Set<SecurityBlockStep>(["ask", "needsyou", "ready", "failed"]);

// The key a hidden merged fix is remembered by: a later fix of the same advisories is another one.
export function mergedFixKey(fix: SecurityFix): string {
    return `${fix.fingerprint}:${fix.mergedat ?? fix.updatedat}`;
}

function stepOf(fix: SecurityFix): SecurityBlockStep {
    switch (fix?.state) {
        case "waiting":
            return "waiting";
        case "working":
            return "working";
        case "needsyou":
            return "needsyou";
        case "ready":
            return "ready";
        case "merged":
            return "merged";
        case "stopped":
            return "stopped";
        case "failed":
            return "failed";
    }
    return "ask";
}

function mergedStillShown(fix: SecurityFix, now: number): boolean {
    return now - (fix.mergedat ?? fix.updatedat) < SecurityFixMergedShownMs;
}

function prOfFix(answer: ReviewsAnswer, fix: SecurityFix): ReviewPr {
    if (fix?.pr == null || fix.pr <= 0) {
        return null;
    }
    return [...(answer?.ready ?? []), ...(answer?.drafts ?? [])].find((pr) => pr.number === fix.pr) ?? null;
}

function viewOf(
    answer: ReviewsAnswer,
    block: SecurityBlock,
    fix: SecurityFix,
    consent: SecurityFixConsent
): SecurityFixBlockView {
    const step = stepOf(fix);
    const advisories = block?.advisories ?? (fix?.ids ?? []).map((id): SecurityAdvisory => ({ id }));
    const prs =
        fix == null
            ? sharedSecurityPrNumbers(block)
            : step === "merged" && (fix.unblocks?.length ?? 0) > 0
              ? fix.unblocks
              : securityFixUnblocks(answer, fix);
    return {
        key: block?.fingerprint ?? fix.fingerprint,
        step,
        consent,
        block,
        fix,
        advisories,
        prs,
        pr: prOfFix(answer, fix),
        needsYou: NeedsYou.has(step),
    };
}

// securityFixBlocks: the blocks the panel shows, at the top of the list: each shared block with the fix that stands for it,
// then the fixes that merged lately and whose blocked pull requests are still to resume. A merged fix with nothing to
// unblock, or one the developer hid, shows nothing; a block whose merged fix is old asks again. now: Unix ms.
export function securityFixBlockViews(
    answer: ReviewsAnswer,
    consent: SecurityFixConsent,
    now: number,
    hidden: SecurityFixHidden = NothingHidden
): SecurityFixBlockView[] {
    const views: SecurityFixBlockView[] = [];
    const told = new Set<string>();
    for (const block of answer?.securityblocks ?? []) {
        if (!block.shared || told.has(block.fingerprint)) {
            continue;
        }
        let fix = securityFixOfBlock(answer, block);
        if (fix?.state === "merged") {
            told.add(fix.fingerprint);
            if (mergedStillShown(fix, now)) {
                const view = viewOf(answer, block, fix, consent);
                if (view.prs.length > 0 && !hidden.dismissed(mergedFixKey(fix))) {
                    views.push(view);
                }
                continue;
            }
            fix = null;
        }
        const view = viewOf(answer, block, fix, consent);
        if (view.step === "ask" && hidden.later(view.key)) {
            continue;
        }
        views.push(view);
    }
    for (const fix of mergedSecurityFixes(answer)) {
        if (told.has(fix.fingerprint) || !mergedStillShown(fix, now) || hidden.dismissed(mergedFixKey(fix))) {
            continue;
        }
        told.add(fix.fingerprint);
        const view = viewOf(answer, null, fix, consent);
        if (view.prs.length > 0) {
            views.push(view);
        }
    }
    const first = views.find((view) => view.needsYou);
    return views.map((view) => ({ ...view, needsYou: view.needsYou && view === first }));
}

// The key of the block that holds the panel's one filled button, null when none needs the developer: only the first block
// that does, the others stay calm.
export function securityFilledBlock(views: readonly SecurityFixBlockView[]): string {
    return views.find((view) => view.needsYou)?.key ?? null;
}

// What a merged fix's blocked pull request is doing now, by what the list says of it (FR-REV-036 AC17, the mockup's fourth
// step). Without more, the list is the only truth: its checks run, are green, or still wait for the pull request to be
// brought onto the fixed trunk. outcome: the work that follows the merge (the unblock step, #2590) says what it did, when it
// recorded it.
export type SecurityUnblockOutcome = { pr: number; how: "updated" | "handed" | "rerun" | "failed"; agent?: string };

// The data hook of the unblock step (#2590): it fills this with what it did to each blocked pull request once the fix
// merged. Until it does, the rows say what the list says.
export function securityUnblockOutcomes(_answer: ReviewsAnswer, _fix: SecurityFix): SecurityUnblockOutcome[] {
    return [];
}

export type SecurityUnblockProgress = "running" | "green" | "red" | "waiting" | "gone";

export type SecurityUnblockRow = { pr: number; progress: SecurityUnblockProgress; outcome?: SecurityUnblockOutcome };

// securityUnblockRows: one row per pull request the merged fix unblocked.
export function securityUnblockRows(
    answer: ReviewsAnswer,
    fix: SecurityFix,
    outcomes: readonly SecurityUnblockOutcome[] = securityUnblockOutcomes(answer, fix)
): SecurityUnblockRow[] {
    const listed = [...(answer?.ready ?? []), ...(answer?.drafts ?? [])];
    return (fix?.unblocks ?? []).map((number) => {
        const pr = listed.find((p) => p.number === number);
        const outcome = outcomes.find((o) => o.pr === number);
        return { pr: number, progress: progressOf(pr), ...(outcome != null ? { outcome } : {}) };
    });
}

function progressOf(pr: ReviewPr): SecurityUnblockProgress {
    if (pr == null) {
        return "gone";
    }
    const ci = pr.ci;
    if ((ci?.pending ?? 0) > 0 || ci?.state === "pending") {
        return "running";
    }
    if (pr.securityblock != null && (ci?.failure ?? 0) > 0) {
        return "waiting";
    }
    if ((ci?.failure ?? 0) > 0) {
        return "red";
    }
    return "green";
}
