// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The fix of a shared security block (FR-REV-036 AC9 to AC13, #2589): the wire types of the answer's securityfixes
// (pkg/molten/secfix/fix.go, filled by pkg/molten/mission/reviews_securityfix.go), the developer's consent to start one
// without a click, and the pure helpers the Integration panel (its block, the card state, the tag on the fix's pull
// request) and what follows a merged fix read them with. wavesrv starts, follows and stops the fix; nothing here does.

import type { ReviewsAnswer } from "./reviews-model";
import { sharedSecurityPrNumbers, type SecurityBlock } from "./reviews-security-model";

// must match the Fix… constants in pkg/molten/secfix/fix.go
export type SecurityFixState = "waiting" | "working" | "needsyou" | "ready" | "merged" | "stopped" | "failed";

// must match the Reason… constants in pkg/molten/secfix/fix.go
export type SecurityFixReason =
    | "machinebusy"
    | "agentlimit"
    | "launchfailed"
    | "noagent"
    | "noworkspace"
    | "outcome"
    | "nopr"
    | "checksfailed"
    | "newadvisory"
    | "agentgone"
    | "prclosed"
    | "notready";

// must match the Resolution… constants in pkg/molten/secfix/fix.go: the fix bumps the dependency, or records that the
// advisories do not apply here (a review with its evidence, never an exception)
export type SecurityFixResolution = "bump" | "notapplicable";

// must match Fix in pkg/molten/secfix/fix.go
export type SecurityFix = {
    // keys the set the fix was started for; ids are the advisories it covers now
    fingerprint: string;
    ids: string[];
    dir: string;
    state: SecurityFixState;
    reason?: SecurityFixReason;
    // started without a click, under the developer's consent
    auto?: boolean;
    // someone else's pull request or agent was there first: MoltenTerm only follows it
    external?: boolean;
    ticket?: number;
    // MoltenTerm made the ticket
    ticketnew?: boolean;
    ticketurl?: string;
    pr?: number;
    prurl?: string;
    branch?: string;
    trunk?: string;
    repo?: string;
    resolution?: SecurityFixResolution;
    agent?: string;
    agentname?: string;
    workspaceid?: string;
    tabid?: string;
    blockid?: string;
    // the agent's last line, on one line
    outcome?: string;
    // advisories that joined after the agent started and that it has not been told of yet
    extra?: string[];
    tries?: number;
    // Unix ms: when starting may be tried again without the developer
    retryat?: number;
    startedat: number;
    updatedat: number;
    mergedat?: number;
};

// must match SecurityFixStopGesture in pkg/molten/review/securityfix.go: the notification's Stop
export const SecurityFixStopGesture = "review:securityfix:stop";

// must match SettingKey and ConsentKey in pkg/molten/secfix/fix.go, and ConfirmConsentKeys in settings/settings-catalog.ts
export const SecurityFixSettingKey = "review:securityfix";
export const SecurityFixConsentKey = "molten:securityfix";

// What the developer answered about starting the fix on its own: never asked (the block asks once), no (MoltenTerm only
// offers it), or yes.
export type SecurityFixConsent = "unasked" | "off" | "on";

// The same reading wavesrv makes (secfix.ConsentOf): the setting alone is no consent, the confirmation must be there too.
export function securityFixConsentOf(
    setting: boolean | undefined,
    clientMeta: Record<string, unknown>
): SecurityFixConsent {
    if (setting == null) {
        return "unasked";
    }
    if (!setting) {
        return "off";
    }
    const at = clientMeta?.[SecurityFixConsentKey];
    return typeof at === "number" && at > 0 ? "on" : "off";
}

// The developer's answer to the first-time ask: start it on its own each time ("always"), or only when asked ("ask": this
// time only, and MoltenTerm offers it from then on).
export type SecurityFixAnswer = "always" | "ask";

// What the answer writes: the confirmation wavesrv requires (in the client's meta, which a terminal cannot write), and the
// setting (which a terminal cannot set either).
export function securityFixConsentWrites(
    answer: SecurityFixAnswer,
    now: number
): { clientMeta: Record<string, number | null>; settings: Record<string, boolean> } {
    const always = answer === "always";
    return {
        clientMeta: { [SecurityFixConsentKey]: always ? now : null },
        settings: { [SecurityFixSettingKey]: always },
    };
}

export function securityFixesOf(answer: ReviewsAnswer): SecurityFix[] {
    return answer?.securityfixes ?? [];
}

// A fix in flight: no other starts, and its advisories are covered.
export function isSecurityFixInFlight(fix: SecurityFix): boolean {
    return fix?.state === "waiting" || fix?.state === "working" || fix?.state === "needsyou" || fix?.state === "ready";
}

// A fix the developer can stop: MoltenTerm's own, in flight.
export function isSecurityFixStoppable(fix: SecurityFix): boolean {
    return isSecurityFixInFlight(fix) && fix.external !== true;
}

// Whether the fix covers every one of the advisories: its own, and the ones that joined its set.
export function securityFixCovers(fix: SecurityFix, ids: string[]): boolean {
    if (fix == null || ids.length === 0) {
        return false;
    }
    return ids.every((id) => fix.ids.includes(id) || (fix.extra ?? []).includes(id));
}

// The fix that stands for a block: one in flight first, else the latest that ended (as pkg/molten/secfix FixOfBlock).
export function securityFixOfBlock(answer: ReviewsAnswer, block: SecurityBlock): SecurityFix {
    if (block == null) {
        return null;
    }
    const ids = block.advisories.map((advisory) => advisory.id);
    let best: SecurityFix = null;
    for (const fix of securityFixesOf(answer)) {
        if (!securityFixCovers(fix, ids) && fix.fingerprint !== block.fingerprint) {
            continue;
        }
        if (
            best == null ||
            (isSecurityFixInFlight(fix) && !isSecurityFixInFlight(best)) ||
            (isSecurityFixInFlight(fix) === isSecurityFixInFlight(best) && fix.updatedat > best.updatedat)
        ) {
            best = fix;
        }
    }
    return best;
}

// The pull requests the fix's merge unblocks, as the answer holds them: the ones of its block that did not cause it.
export function securityFixUnblocks(answer: ReviewsAnswer, fix: SecurityFix): number[] {
    if (fix == null) {
        return [];
    }
    for (const block of answer?.securityblocks ?? []) {
        const blockIds = block.advisories.map((advisory) => advisory.id);
        if (securityFixCovers(fix, blockIds) || block.fingerprint === fix.fingerprint) {
            return sharedSecurityPrNumbers(block).filter((number) => number !== fix.pr);
        }
    }
    return [];
}

// The fix in flight that stands for a pull request's blocked scan (the card state "blocked by a security fix"): the
// pull request is in a block, shared, and a fix in flight covers the block's advisories.
export function securityFixCoveringPr(answer: ReviewsAnswer, number: number): SecurityFix {
    const pr = [...(answer?.ready ?? []), ...(answer?.drafts ?? [])].find((p) => p.number === number);
    const block = (answer?.securityblocks ?? []).find((b) => b.fingerprint === pr?.securityblock);
    if (block == null || !block.prs.some((p) => p.number === number && p.shared)) {
        return null;
    }
    const fix = securityFixOfBlock(answer, block);
    return fix != null && isSecurityFixInFlight(fix) ? fix : null;
}

// Whether a block can be fixed: the project declared the scan or the developer confirmed it, the failure is shared, and no
// fix stands for it. A set whose fix was stopped or failed still can, on the developer's click only.
export function isSecurityBlockFixable(answer: ReviewsAnswer, block: SecurityBlock): boolean {
    if (block == null || !block.shared || (block.origin !== "declared" && block.origin !== "confirmed")) {
        return false;
    }
    const fix = securityFixOfBlock(answer, block);
    return fix == null || !isSecurityFixInFlight(fix);
}

// The blocks to show in the panel's security fix block: shared ones, each with the fix that stands for it (null for none).
export function securityFixBlocks(answer: ReviewsAnswer): { block: SecurityBlock; fix: SecurityFix }[] {
    return (answer?.securityblocks ?? [])
        .filter((block) => block.shared)
        .map((block) => ({ block, fix: securityFixOfBlock(answer, block) }));
}

// The fix that was merged and whose blocked pull requests still wait for it: the panel's last state ("after the merge").
export function mergedSecurityFixes(answer: ReviewsAnswer): SecurityFix[] {
    return securityFixesOf(answer).filter((fix) => fix.state === "merged");
}
