// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The card's status line (#1876, FR-REV-001 AC17): one line, under the state sentence, that says what runs on the PR
// now ("CI running · 5/6 · Backend · 6 min", "Arthur works on it · 4 min", the merge queue's step) or "Nothing runs"
// and why ("CI finished 3 h ago, red on Backend"). It is true by construction: a card with a check running is never
// idle, and a card where nothing runs never looks busy. Pure, so the sections, the dots and the card read the same truth.

import { t } from "../i18n/i18n";
import { phrase, type Phrase } from "../i18n/phrase";
import { batchStatePhrase } from "./reviews-batch-agent";
import type { CardInput, CardStateKind } from "./reviews-card-model";
import { checkNames, checksOf, type ReviewCheck } from "./reviews-model";
import { durationText, type AgentBarFacts } from "./reviews-upcoming-model";

// running: something runs on the PR now, so the card shows the dominoes beside the line.
export type CardStatus = { running: boolean; line: Phrase };

// The agents the card names, worded by the card model (agentName, ownName).
export type StatusWho = {
    working: AgentBarFacts;
    workingName: Phrase;
    waitingName: Phrase;
    stoppedName: Phrase;
    taskName: Phrase;
};

function startedMs(check: ReviewCheck): number {
    const ms = Date.parse(check.startedat ?? "");
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function endedMs(check: ReviewCheck): number {
    const ms = Date.parse(check.completedat ?? "");
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// The oldest start of the checks that run: how long the CI has been running.
function runningSince(running: readonly ReviewCheck[]): number {
    const starts = running.map(startedMs).filter((ms) => ms > 0);
    return starts.length > 0 ? Math.min(...starts) : 0;
}

// When the CI ended: the last of the finished checks' ends, 0 when GitHub did not say.
function endedAt(checks: readonly ReviewCheck[]): number {
    return Math.max(0, ...checks.map(endedMs));
}

function elapsed(now: number, since: number): string {
    return durationText(t, Math.max(0, now - since));
}

function runningLine(input: CardInput, kind: CardStateKind, who: StatusWho, now: number): Phrase {
    const { pr } = input;
    const item = input.batch?.item;
    if (who.working?.batch && input.batch != null) {
        return batchStatePhrase(input.batch.run, item, who.working.name);
    }
    if (who.working != null) {
        const since = who.working.kind === "background" ? 0 : who.working.since;
        return since > 0
            ? phrase("reviews.card.status.agentSince", { name: who.workingName, elapsed: elapsed(now, since) })
            : phrase("reviews.card.status.agent", { name: who.workingName });
    }
    const pending = checksOf(pr.ci, "pending");
    if (pending.length > 0 || (pr.ci?.pending ?? 0) > 0) {
        const total = pr.ci?.checks?.length ?? 0;
        const vars = { done: Math.max(0, total - pending.length), total, names: checkNames(pending) };
        const since = runningSince(pending);
        return since > 0
            ? phrase("reviews.card.status.ciSince", { ...vars, elapsed: elapsed(now, since) })
            : phrase("reviews.card.status.ci", vars);
    }
    if (kind === "agent-working") {
        return phrase("reviews.card.status.agentProbably");
    }
    return phrase("reviews.card.status.merge");
}

// Whether something runs on the PR. The merge queue's work and an agent at work come first, then a check that runs,
// then GitHub computing the mergeability; a kind that infers an agent from the board or a recent commit runs too.
function running(input: CardInput, kind: CardStateKind, who: StatusWho): boolean {
    const { pr } = input;
    return (
        who.working != null ||
        checksOf(pr.ci, "pending").length > 0 ||
        (pr.ci?.pending ?? 0) > 0 ||
        pr.merge === "unknown" ||
        kind === "agent-working"
    );
}

function ciEndedWhy(input: CardInput, now: number, green: boolean): Phrase {
    const { pr } = input;
    const checks = pr.ci?.checks ?? [];
    const failed = checksOf(pr.ci, "failure");
    const ended = endedAt(green ? checks : failed);
    if (green) {
        return ended > 0
            ? phrase("reviews.card.status.why.ciGreenAgo", { ago: elapsed(now, ended) })
            : phrase(checks.length > 0 ? "reviews.card.status.why.ciGreen" : "reviews.card.status.why.ciNone");
    }
    const names = checkNames(failed);
    return ended > 0
        ? phrase("reviews.card.status.why.ciFailedAgo", { ago: elapsed(now, ended), names })
        : phrase("reviews.card.status.why.ciFailed", { names });
}

// idleWhy: why nothing runs, by the card's state.
function idleWhy(input: CardInput, kind: CardStateKind, who: StatusWho, now: number): Phrase {
    const { pr } = input;
    switch (kind) {
        case "agent-waiting":
            return phrase("reviews.card.status.why.agentWaiting", { name: who.waitingName });
        case "waiting-on": {
            const first = input.waitsOn?.[0];
            return phrase("reviews.card.status.why.waitingOn", { number: first?.number ?? 0 });
        }
        case "agent-finish":
            return phrase("reviews.card.status.why.agentFinish", { name: who.stoppedName });
        case "interrupted":
            return phrase("reviews.card.status.why.interrupted", { name: who.taskName });
        case "conflicts":
            return phrase("reviews.card.status.why.conflicts", { base: pr.base });
        case "failing":
            return checksOf(pr.ci, "failure").length > 0
                ? ciEndedWhy(input, now, false)
                : phrase("reviews.card.status.why.changes");
        case "queue-stopped":
            return phrase("reviews.card.status.why.queueStopped");
        case "ci-trust":
            return phrase("reviews.card.status.why.ciTrust");
        case "ci-stopped":
            return phrase("reviews.card.status.why.ciStopped");
        case "ci-elsewhere":
            return phrase("reviews.card.status.why.ciElsewhere");
        case "review-required":
            return phrase(
                (pr.reviewdecision ?? "").toUpperCase() === "REVIEW_REQUIRED"
                    ? "reviews.card.status.why.approval"
                    : "reviews.card.status.why.rule"
            );
        case "draft-ready":
            return phrase("reviews.card.status.why.draftToTest", { ci: ciEndedWhy(input, now, true) });
    }
    return ciEndedWhy(input, now, true);
}

// cardStatus: the one line. A check that runs wins over the card's other words: the line never reads idle then.
export function cardStatus(input: CardInput, kind: CardStateKind, who: StatusWho, now: number): CardStatus {
    if (running(input, kind, who)) {
        return { running: true, line: runningLine(input, kind, who, now) };
    }
    return { running: false, line: phrase("reviews.card.status.idle", { why: idleWhy(input, kind, who, now) }) };
}
