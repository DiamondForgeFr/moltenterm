// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's data (FR-REV-001, DS-REV-001): wavesrv derives the list from Mission Control's collector
// (pkg/molten/mission/reviews.go); this side only words it. The pure helpers live here so they can be tested.

import { t } from "../i18n/i18n";
import { joinPhrases, phrase, serverPhrase, type Phrase } from "../i18n/phrase";
import { type ServerText } from "../i18n/server-text";
import { CheckState } from "../mission/github";
import type { ReviewCleanupPr, ReviewCleanupResult } from "../review/review-cleanup";
import type { InvestigateBlockers } from "../review/review-client";
import type { ReviewMergedPr } from "./reviews-merged-model";
import type { PrTaskKind } from "./reviews-task-model";

export const MoltentermReviewsView = "molten-reviews";

// must match the constants in pkg/molten/mission/reviews.go
export type ReviewMerge = "clean" | "behind" | "conflicts" | "blocked" | "failing" | "running" | "unknown";
export type ReviewReportState = "present" | "missing" | "unknown";
export type ReviewCheckState = CheckState | "none";

export type ReviewCheck = {
    name: string;
    state: CheckState;
    local?: boolean;
    workflow?: string;
    url?: string;
    runid?: number;
    jobid?: number;
};

export type ReviewCi = {
    state: ReviewCheckState;
    success: number;
    failure: number;
    pending: number;
    checks: ReviewCheck[];
};

export type ReviewReport = { state: ReviewReportState; url?: string; where?: "pr" | "ticket" };

// must match ReviewPr in pkg/molten/mission/reviews.go
export type ReviewPr = {
    number: number;
    title: string;
    url: string;
    branch: string;
    base: string;
    headoid?: string;
    baseoid?: string;
    author?: string;
    draft?: boolean;
    createdat: string;
    updatedat: string;
    ticket?: number;
    ticketfrom?: "closing" | "branch";
    tickettitle?: string;
    ticketurl?: string;
    mergeable?: string;
    mergestate?: string;
    merge: ReviewMerge;
    reviewdecision?: string;
    ci: ReviewCi;
    report: ReviewReport;
    unpublished: number;
    // who worked on the PR, the last agent first (#847); absent: unknown agent
    agents?: AgentSignature[];
};

// must match Signature in pkg/molten/agentsign/agentsign.go
export type AgentSignature = { firstname?: string; agent?: string; model?: string; effort?: string };

// must match ReviewsAnswer in pkg/molten/mission/reviews.go
export type ReviewsAnswer = {
    dir: string;
    missing?: boolean;
    state?: "" | "ok" | "nogh" | "loggedout" | "norepo" | "error";
    message?: string;
    repo?: string;
    url?: string;
    target?: string;
    targetfrom?: string;
    ready: ReviewPr[];
    drafts: ReviewPr[];
    merged?: ReviewMergedPr[];
    mergederror?: string;
    prserror?: string;
    githubat?: number;
    refreshing?: boolean;
    reportsat?: number;
    reportserror?: string;
};

export type Tone = "success" | "failure" | "pending" | "neutral";

// FR-REV-001-AC2, #683: ready to merge, behind (GitHub updates it at the merge), conflicts (a warning: an agent can
// rebase it), blocked, checking while GitHub computes the mergeability.
export function mergeLabel(merge: ReviewMerge, base: string): { label: string; tone: Tone; title: string } {
    switch (merge) {
        case "clean":
            return { label: t("reviews.merge.clean"), tone: "success", title: t("reviews.merge.cleanTitle") };
        case "behind":
            return {
                label: t("reviews.merge.behind", { base }),
                tone: "neutral",
                title: t("reviews.merge.behindTitle", { base }),
            };
        case "conflicts":
            return {
                label: t("reviews.merge.conflicts", { base }),
                tone: "pending",
                title: t("reviews.merge.conflictsTitle", { base }),
            };
        case "blocked":
            return {
                label: t("reviews.merge.blocked"),
                tone: "failure",
                title: t("reviews.merge.blockedTitle"),
            };
        case "failing":
            return { label: t("reviews.merge.failing"), tone: "failure", title: t("reviews.merge.failingTitle") };
        case "running":
            return { label: t("reviews.merge.running"), tone: "neutral", title: t("reviews.merge.runningTitle") };
    }
    return { label: t("reviews.merge.pending"), tone: "neutral", title: t("reviews.merge.pendingTitle") };
}

// blockedReasons says why GitHub blocks a PR's merge (#797), from what the row knows: its failed and running checks, a
// conflict, the review decision; else a branch rule the list cannot read.
export function blockedReasons(pr: ReviewPr): string[] {
    const reasons: string[] = [];
    const failed = checksOf(pr.ci, "failure");
    if (failed.length > 0) {
        reasons.push(t("reviews.merge.why.failed", { names: checkNames(failed) }));
    }
    const running = checksOf(pr.ci, "pending");
    if (running.length > 0) {
        reasons.push(t("reviews.merge.why.pending", { names: checkNames(running) }));
    }
    if (pr.merge === "conflicts") {
        reasons.push(t("reviews.merge.why.conflicts", { base: pr.base }));
    }
    switch ((pr.reviewdecision ?? "").toUpperCase()) {
        case "REVIEW_REQUIRED":
            reasons.push(t("reviews.merge.why.review"));
            break;
        case "CHANGES_REQUESTED":
            reasons.push(t("reviews.merge.why.changes"));
            break;
    }
    if (reasons.length === 0) {
        reasons.push(t("reviews.merge.why.rule"));
    }
    return reasons;
}

// mergeLabelOf is a row's merge chip; blocked says why on hover (#797).
export function mergeLabelOf(pr: ReviewPr): { label: string; tone: Tone; title: string } {
    const label = mergeLabel(pr.merge, pr.base);
    if (pr.merge !== "blocked") {
        return label;
    }
    return { ...label, title: t("reviews.merge.blockedWhy", { reasons: blockedReasons(pr).join("; ") }) };
}

// validateBlocked is why a row's Validate cannot open the sheet, "" when it can (#683). It names only what GitHub
// refuses and the row already knows (pkg/molten/review/merge.go's evaluate): a draft, conflicts, a blocked state. Red
// checks GitHub does not require (merge "failing", GitHub's UNSTABLE) never block: the sheet asks to confirm them
// (#943). Running checks and a merge state still computing do not block either: the sheet waits for them.
export function validateBlocked(pr: ReviewPr): string {
    if (pr.draft) {
        return t("reviews.validate.draft");
    }
    if (pr.merge === "conflicts") {
        return t("reviews.validate.conflicts", { base: pr.base });
    }
    if (pr.merge === "blocked") {
        return t("reviews.merge.blockedWhy", { reasons: blockedReasons(pr).join("; ") });
    }
    return "";
}

// A rebase asked from a row: to whom, and on which head. It shows until the PR's head changes (the agent pushed).
// The work asked of a PR's agent (#683), by rebaseAskKey; kind (#954): a rebase when absent.
export type RebaseAsk = { name: string; head: string; at: number; kind?: PrTaskKind; blockId?: string };

export function rebaseAskKey(dir: string, number: number): string {
    return `${dir}#${number}`;
}

export function rebaseAskShown(ask: RebaseAsk, pr: ReviewPr): boolean {
    if (ask == null || (ask.kind != null && ask.kind !== "rebase")) {
        return false;
    }
    return !ask.head || !pr.headoid || ask.head === pr.headoid;
}

// cleanupRebaseAsks: the rebases the cleanup after a merge asked (#691), so the Reviews rows show "Rebase asked to
// <name>" as for a row's click. An ask already recorded since is kept.
export function cleanupRebaseAsks(
    asks: Record<string, RebaseAsk>,
    dir: string,
    cleanup: ReviewCleanupResult
): Record<string, RebaseAsk> {
    const others = cleanup?.steps?.find((s) => s.id === "other-prs");
    let rtn = asks;
    for (const pr of others?.prs ?? []) {
        if ((pr.flag !== "rebase-asked" && pr.flag !== "rebase-typed") || !pr.agent) {
            continue;
        }
        const key = rebaseAskKey(dir, pr.number);
        const at = cleanup.endedat ?? 0;
        if ((asks[key]?.at ?? -1) >= at) {
            continue;
        }
        rtn = { ...rtn, [key]: { name: pr.agent, head: pr.headoid ?? "", at } };
    }
    return rtn;
}

// reviewPrOfCleanup is the Reviews row of another PR the cleanup reported, for its Start an agent (#691).
export function reviewPrOfCleanup(pr: ReviewCleanupPr, base: string): ReviewPr {
    return {
        number: pr.number,
        title: pr.title ?? "",
        url: pr.url ?? "",
        branch: pr.branch,
        base,
        headoid: pr.headoid,
        createdat: "",
        updatedat: "",
        merge: "conflicts",
        ci: null,
        report: null,
        unpublished: 0,
    };
}

// must match RestartResult in pkg/molten/review/restart.go, as Ask for a rebase answers it (rebase.go)
export type RebaseResult = {
    status: string;
    reason?: string;
    agentstate?: string;
    branch?: string;
    message?: string;
    messagetext?: ServerText;
    worktree?: string;
    blockid?: string;
    agent?: string;
    agentname?: string;
    firstname?: string;
    briefpath?: string;
    tabid?: string;
    hidden?: boolean;
    // The developer's coding agent (#845).
    chosenagent?: string;
    chosenname?: string;
    agentmissing?: boolean;
    agentsource?: string;
    agents?: { id: string; name: string; installed: boolean }[];
};

// asked: the agent has it (name), note when the developer still has a step or should know where it went; offer: no
// agent on the branch, the developer chooses how one starts (agent: the one that would, result: wavesrv's offer with
// the agents to switch to); info and failed: a line. text is worded where it shows (wordPhrase, #1058).
export type RebaseOutcome = {
    kind: "asked" | "offer" | "info" | "failed";
    name?: string;
    blockId?: string;
    agent?: string;
    result?: RebaseResult;
    text: Phrase;
    note?: boolean;
    // The agent busy on the branch (#1062): the card offers to hand it the task after its own.
    busy?: { blockId: string; name: string };
};

// notChosen: the agent already on the branch took the work, not the one the developer chose (#845).
function notChosen(result: RebaseResult, name: string): Phrase {
    if (!result.chosenname || !result.agent || result.chosenagent === result.agent) {
        return null;
    }
    return phrase("reviews.rebase.notChosen", { name, chosen: result.chosenname });
}

function folderOf(path: string): string {
    const parts = (path ?? "").split(/[/\\]/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? "";
}

// The sentences that name what was asked (a rebase, or an investigation of the CI, #797); the others are shared.
const OutcomeKeys = {
    rebase: {
        asked: "reviews.rebase.asked",
        startedHidden: "reviews.rebase.startedHidden",
        offer: "reviews.rebase.offer",
        failed: "reviews.rebase.failed",
    },
    investigate: {
        asked: "reviews.ci.investigate.asked",
        startedHidden: "reviews.ci.investigate.startedHidden",
        offer: "reviews.ci.investigate.offer",
        failed: "reviews.ci.investigate.failed",
    },
    finish: {
        asked: "reviews.check.asked",
        startedHidden: "reviews.check.startedHidden",
        offer: "reviews.check.offer",
        failed: "reviews.check.askFailed",
    },
};

// rebaseOutcome: the line for what wavesrv answered; an agent that took the work carries its terminal (#954).
export function rebaseOutcome(
    result: RebaseResult,
    error?: Phrase,
    what: keyof typeof OutcomeKeys = "rebase"
): RebaseOutcome {
    const outcome = outcomeOf(result, error, what);
    if (outcome?.kind === "asked" && result?.blockid) {
        outcome.blockId = result.blockid;
    }
    return outcome;
}

function outcomeOf(result: RebaseResult, error: Phrase, what: keyof typeof OutcomeKeys): RebaseOutcome {
    const keys = OutcomeKeys[what];
    if (error) {
        return { kind: "failed", text: phrase(keys.failed, { message: error }) };
    }
    if (result == null) {
        return null;
    }
    const name = result.firstname || result.agentname || result.agent || "";
    const vars = {
        name,
        branch: result.branch ?? "",
        folder: folderOf(result.worktree),
        brief: result.briefpath ?? "",
        message: serverPhrase(result.messagetext, result.message ?? ""),
    };
    switch (result.status) {
        case "started":
            if (result.hidden) {
                return { kind: "asked", name, text: phrase(keys.startedHidden, vars), note: true };
            }
            return { kind: "asked", name, text: phrase(keys.asked, vars), note: what === "investigate" };
        case "sent": {
            const other = notChosen(result, name);
            return {
                kind: "asked",
                name,
                text: joinPhrases([phrase(keys.asked, vars), other]),
                note: what === "investigate" || other != null,
            };
        }
        case "typed":
            return {
                kind: "asked",
                name,
                text: joinPhrases([phrase("reviews.rebase.typed", vars), notChosen(result, name)]),
                note: true,
            };
        case "offer":
            return { kind: "offer", text: phrase(keys.offer, vars), agent: result.agentname ?? "", result };
        case "noagent":
            if (result.reason === "agentmissing") {
                return {
                    kind: "failed",
                    text: phrase("reviews.rebase.agentmissing", { chosen: result.chosenname ?? "" }),
                };
            }
            return { kind: "failed", text: phrase("reviews.rebase.noagent", vars) };
        case "busy":
            switch (result.reason) {
                case "agentbusy":
                    return {
                        kind: "info",
                        text:
                            result.agentstate === "waiting"
                                ? phrase("reviews.rebase.waiting", vars)
                                : phrase("reviews.rebase.working", vars),
                        busy: result.blockid ? { blockId: result.blockid, name } : undefined,
                    };
                case "inflight":
                    return { kind: "info", text: phrase("reviews.rebase.inflight") };
            }
            return { kind: "info", text: phrase("reviews.rebase.notready", vars) };
    }
    switch (result.reason) {
        case "maincheckout":
            return { kind: "failed", text: phrase("reviews.rebase.maincheckout", vars) };
        case "terminal":
            return { kind: "failed", text: phrase("reviews.rebase.terminal") };
    }
    return { kind: "failed", text: phrase(keys.failed, vars) };
}

const CheckStateKeys: Record<CheckState, string> = {
    success: "reviews.ci.state.success",
    failure: "reviews.ci.state.failure",
    pending: "reviews.ci.state.pending",
    neutral: "reviews.ci.state.neutral",
};

// The checks shown by name before "+N" (#797).
const NamedChecks = 2;

export function checksOf(ci: ReviewCi, state: CheckState): ReviewCheck[] {
    return (ci?.checks ?? []).filter((c) => c.state === state);
}

// checkNames names the first checks, then how many more.
export function checkNames(checks: readonly ReviewCheck[]): string {
    const names = checks.slice(0, NamedChecks).map((c) => c.name);
    if (checks.length <= NamedChecks) {
        return names.join(", ");
    }
    return t("reviews.ci.more", { names: names.join(", "), count: checks.length - NamedChecks });
}

// isLocalCheck: a status the local CI posts (molten ci run's local-<job>, or a check named after the local CI); must
// match IsLocalCiCheck in pkg/molten/review/investigate.go.
export function isLocalCheck(check: ReviewCheck): boolean {
    const name = (check?.name ?? "").toLowerCase();
    return !!check?.local || name.startsWith("local-") || name.includes("local ci") || name.includes("local-ci");
}

// What blocks a PR, in the order Analyze and resolve hands it to the agent (#1020, FR-REV-028 AC6): the rebase first,
// then the remote checks, the local CI, the test report and the review round.
export type ReviewBlocker =
    | { kind: "rebase"; conflicts: boolean }
    | { kind: "remote"; checks: ReviewCheck[] }
    | { kind: "local"; checks: ReviewCheck[] }
    | { kind: "report" }
    | { kind: "review" };

export function prBlockers(pr: ReviewPr): ReviewBlocker[] {
    if (pr == null) {
        return [];
    }
    const blockers: ReviewBlocker[] = [];
    if (pr.merge === "behind" || pr.merge === "conflicts") {
        blockers.push({ kind: "rebase", conflicts: pr.merge === "conflicts" });
    }
    const failed = checksOf(pr.ci, "failure");
    const remote = failed.filter((c) => !isLocalCheck(c));
    const local = failed.filter(isLocalCheck);
    if (remote.length > 0) {
        blockers.push({ kind: "remote", checks: remote });
    }
    if (local.length > 0) {
        blockers.push({ kind: "local", checks: local });
    }
    if (pr.report?.state === "missing") {
        blockers.push({ kind: "report" });
    }
    if ((pr.reviewdecision ?? "").toUpperCase() === "CHANGES_REQUESTED") {
        blockers.push({ kind: "review" });
    }
    return blockers;
}

export function blockerText(blocker: ReviewBlocker, base: string): string {
    switch (blocker.kind) {
        case "rebase":
            return blocker.conflicts
                ? t("reviews.ci.investigate.blocker.conflicts", { base })
                : t("reviews.ci.investigate.blocker.behind", { base });
        case "remote":
            return t("reviews.ci.investigate.blocker.remote", { names: checkNames(blocker.checks) });
        case "local":
            return t("reviews.ci.investigate.blocker.local", { names: checkNames(blocker.checks) });
        case "report":
            return t("reviews.ci.investigate.blocker.report");
        case "review":
            return t("reviews.ci.investigate.blocker.review");
    }
    return "";
}

// investigateBlockers: what Analyze and resolve sends wavesrv of the row's blockers; wavesrv adds what only it knows (an
// unanswered review round, a local CI not run on the head).
export function investigateBlockers(pr: ReviewPr): InvestigateBlockers {
    const failed = checksOf(pr?.ci, "failure");
    return {
        checks: failed.map((c) => ({
            name: c.name,
            workflow: c.workflow,
            url: c.url,
            runid: c.runid,
            jobid: c.jobid,
            local: isLocalCheck(c) || undefined,
        })),
        merge: pr?.merge === "behind" || pr?.merge === "conflicts" ? pr.merge : undefined,
        changesrequested: (pr?.reviewdecision ?? "").toUpperCase() === "CHANGES_REQUESTED" || undefined,
        noreport: pr?.report?.state === "missing" || undefined,
        localseen: (pr?.ci?.checks ?? []).some((c) => c.name.toLowerCase().startsWith("local-")) || undefined,
    };
}

// blockersText: "behind develop, CI failed: Backend, local CI failed: local-e2e", in the brief's order.
export function blockersText(pr: ReviewPr): string {
    return prBlockers(pr)
        .map((b) => blockerText(b, pr.base))
        .join(", ");
}

// #797: a failed check is named on the chip (CI: Backend failed); the title lists every check with its state.
export function ciLabel(ci: ReviewCi): { label: string; tone: Tone; title: string } {
    const checks = ci?.checks ?? [];
    const title =
        checks
            .map((c) =>
                t("reviews.ci.checkLine", { name: c.name, state: t(CheckStateKeys[c.state] ?? CheckStateKeys.neutral) })
            )
            .join("\n") || t("reviews.ci.noneTitle");
    if (checks.length === 0) {
        return { label: t("reviews.ci.none"), tone: "neutral", title };
    }
    const failed = checksOf(ci, "failure");
    if (failed.length > 0) {
        return { label: t("reviews.ci.failedLabel", { names: checkNames(failed) }), tone: "failure", title };
    }
    const parts: string[] = [];
    if (ci.pending > 0) {
        parts.push(t("reviews.ci.running", { count: ci.pending }));
    }
    if (ci.success > 0) {
        parts.push(t("reviews.ci.passed", { count: ci.success }));
    }
    const tone: Tone =
        ci.state === "failure"
            ? "failure"
            : ci.state === "pending"
              ? "pending"
              : ci.state === "success"
                ? "success"
                : "neutral";
    return {
        label: t("reviews.ci.label", {
            parts: parts.join(", ") || t("reviews.ci.skipped", { count: checks.length }),
        }),
        tone,
        title,
    };
}

export function reportLabel(report: ReviewReport): { label: string; tone: Tone; title: string } {
    switch (report?.state) {
        case "present":
            return {
                label: t("reviews.report.present"),
                tone: "success",
                title: report.where === "ticket" ? t("reviews.report.onTicket") : t("reviews.report.onPr"),
            };
        case "missing":
            return {
                label: t("reviews.report.missing"),
                tone: "pending",
                title: t("reviews.report.missingTitle"),
            };
    }
    return { label: t("reviews.report.looking"), tone: "neutral", title: t("reviews.report.lookingTitle") };
}

// The row's main line: the ticket and its title when the PR names one, else the PR's own title.
export function reviewHeadline(pr: ReviewPr): { ticket: string; title: string } {
    if (!pr.ticket) {
        return { ticket: "", title: pr.title };
    }
    return { ticket: `#${pr.ticket}`, title: pr.tickettitle || pr.title };
}

export function reviewAriaLabel(pr: ReviewPr): string {
    const head = reviewHeadline(pr);
    const parts = [
        head.ticket ? t("reviews.aria.ticket", { ticket: head.ticket, title: head.title }) : head.title,
        t("reviews.aria.pr", { number: pr.number }),
        ciLabel(pr.ci).label,
        reportLabel(pr.report).label,
        mergeLabel(pr.merge, pr.base).label,
    ];
    if (pr.unpublished > 0) {
        parts.push(
            pr.unpublished > 1
                ? t("reviews.aria.unpublished", { count: pr.unpublished })
                : t("reviews.aria.unpublishedOne")
        );
    }
    return parts.join(", ");
}

export type ReviewsEmpty = { icon: string; title: string; hint: string; details?: string };

// FR-REV-001-AC4: the GitHub states Mission Control knows (nogh, loggedout, norepo), with what to do.
export function reviewsEmptyState(answer: ReviewsAnswer): ReviewsEmpty {
    switch (answer?.state) {
        case "nogh":
            return { icon: "terminal", title: t("reviews.empty.noghTitle"), hint: t("reviews.empty.noghHint") };
        case "loggedout":
            return {
                icon: "right-to-bracket",
                title: t("reviews.empty.loggedoutTitle"),
                hint: t("reviews.empty.loggedoutHint"),
            };
        case "norepo":
            return { icon: "code-branch", title: t("reviews.empty.norepoTitle"), hint: t("reviews.empty.norepoHint") };
        case "error":
            return {
                icon: "triangle-exclamation",
                title: t("reviews.empty.errorTitle"),
                hint: t("reviews.empty.errorHint"),
                details: answer.message,
            };
    }
    return null;
}

// Only a failed read can come back on a retry alone; the other empty states wait on the user (install gh, log in, add
// a remote), so their retry is a calm secondary action rather than a call to action that cannot succeed (#744).
export function reviewsRetryIsPrimary(answer: ReviewsAnswer): boolean {
    return answer?.state === "error";
}

export type ReviewsSplit = { ready: ReviewPr[]; drafts: ReviewPr[] };

// The PRs marked ready from MoltenTerm (#687), by rebaseAskKey: when the click was made.
export type ReadiedPrs = Record<string, number>;

// splitReviews is the list's draft/ready split (#687), which the rail's counts read too (#688). The collector already
// splits by isDraft; a PR marked ready here moves to ready at once, until a GitHub read newer than the click (githubat)
// says otherwise: the forced refresh after the click may come back from the collector's cache.
export function splitReviews(answer: ReviewsAnswer, readied?: ReadiedPrs): ReviewsSplit {
    if (answer == null) {
        return { ready: [], drafts: [] };
    }
    const ready = answer.ready ?? [];
    const drafts = answer.drafts ?? [];
    const githubAt = answer.githubat ?? 0;
    const moved = (pr: ReviewPr) => {
        const at = readied?.[rebaseAskKey(answer.dir, pr.number)];
        return at != null && at > githubAt;
    };
    if (!drafts.some(moved)) {
        return { ready, drafts };
    }
    const newest = (a: ReviewPr, b: ReviewPr) => (a.updatedat < b.updatedat ? 1 : a.updatedat > b.updatedat ? -1 : 0);
    return {
        ready: [...ready, ...drafts.filter(moved).map((pr) => ({ ...pr, draft: false }))].sort(newest),
        drafts: drafts.filter((pr) => !moved(pr)),
    };
}

export type ReviewCounts = { toreview: number; mergeable: number; drafts: number };

// mergeableNow: GitHub says the PR merges cleanly (#683) and no check fails or still runs.
export function mergeableNow(pr: ReviewPr): boolean {
    if (pr.draft || pr.merge !== "clean") {
        return false;
    }
    const ci = pr.ci?.state ?? "none";
    return ci === "success" || ci === "none";
}

// The rail's counts (#688, #775): the PRs waiting for review (the list's ready group) split in two disjoint sets that
// add up to them, those that cannot merge yet and those that can merge now; and the open drafts, the list's drafts
// group (#934). Nothing while GitHub could not be read: no badge then.
export function reviewCounts(answer: ReviewsAnswer, readied?: ReadiedPrs): ReviewCounts {
    if (answer?.state !== "ok") {
        return { toreview: 0, mergeable: 0, drafts: 0 };
    }
    const split = splitReviews(answer, readied);
    const mergeable = split.ready.filter(mergeableNow).length;
    return { toreview: split.ready.length - mergeable, mergeable, drafts: split.drafts.length };
}

export function railCountText(count: number): string {
    return count > 99 ? "99+" : String(count);
}

function plural(n: number, key: string): string {
    return t(n === 1 ? `${key}.one` : `${key}.other`, { count: n });
}

// The Reviews icon's tooltip and accessible name: "Reviews — 5 to review, 4 ready to merge, 3 drafts".
export function reviewsRailLabel(counts: ReviewCounts): string {
    const drafts = counts?.drafts ?? 0;
    if (counts == null || (counts.toreview === 0 && counts.mergeable === 0 && drafts === 0)) {
        return t("rail.tools.reviews");
    }
    const parts: string[] = [];
    if (counts.toreview > 0) {
        parts.push(plural(counts.toreview, "rail.tools.reviewsCount.toReview"));
    }
    if (counts.mergeable > 0) {
        parts.push(plural(counts.mergeable, "rail.tools.reviewsCount.mergeable"));
    }
    if (drafts > 0) {
        parts.push(plural(drafts, "rail.tools.reviewsCount.drafts"));
    }
    return t("rail.tools.reviewsCounts", { counts: parts.join(", ") });
}

// The rows a keyboard walks: the ready ones, then the drafts when their group is open.
export function navigableRows(split: ReviewsSplit, draftsOpen: boolean): ReviewPr[] {
    if (split == null) {
        return [];
    }
    return draftsOpen ? [...split.ready, ...split.drafts] : split.ready;
}

// must match MarkReadyResult in pkg/molten/review/markready.go
export type MarkReadyResult = {
    status: "ready" | "failed";
    reason?: "closed" | "permission" | "auth" | "notfound" | "nogh" | "error";
    message?: string;
};

// markReadyError words a failed Mark ready for review in plain words, null when it succeeded (#687).
export function markReadyError(result: MarkReadyResult, error?: Phrase): Phrase {
    if (error) {
        return phrase("reviews.ready.failed.error", { message: error });
    }
    if (result?.status === "ready") {
        return null;
    }
    switch (result?.reason) {
        case "closed":
            return phrase("reviews.ready.failed.closed");
        case "permission":
            return phrase("reviews.ready.failed.permission");
        case "auth":
            return phrase("reviews.ready.failed.auth");
        case "notfound":
            return phrase("reviews.ready.failed.notfound");
        case "nogh":
            return phrase("reviews.ready.failed.nogh");
    }
    return phrase("reviews.ready.failed.error", { message: result?.message ?? "" });
}

export function nextRow(rows: readonly ReviewPr[], current: number, key: string): number {
    if (rows.length === 0) {
        return null;
    }
    const index = rows.findIndex((r) => r.number === current);
    switch (key) {
        case "ArrowDown":
            return rows[Math.min(rows.length - 1, index + 1)].number;
        case "ArrowUp":
            return rows[Math.max(0, index - 1)].number;
        case "Home":
            return rows[0].number;
        case "End":
            return rows[rows.length - 1].number;
    }
    return current;
}

// The owner/name of a PR's GitHub URL (https://github.com/owner/name/pull/12), "" when it is not one.
export function repoOfPrUrl(url: string): string {
    const m = /^https:\/\/[^/]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+/.exec(url ?? "");
    return m ? m[1] : "";
}

// Whether Mission Control's Pull requests waiting block offers Review on a PR: the ones the Reviews view lists.
export function isReviewable(pr: { baseRefName: string; isCrossRepository?: boolean }, target: string): boolean {
    return !!target && pr.baseRefName === target && !pr.isCrossRepository;
}
