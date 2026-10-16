// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's data (FR-REV-001, DS-REV-001): wavesrv derives the list from Mission Control's collector
// (pkg/molten/mission/reviews.go); this side only words it. The pure helpers live here so they can be tested.

import { t } from "../i18n/i18n";
import { serverText, type ServerText } from "../i18n/server-text";
import { CheckState } from "../mission/github";
import type { ReviewCleanupPr, ReviewCleanupResult } from "../review/review-cleanup";

export const MoltentermReviewsView = "molten-reviews";

// must match the constants in pkg/molten/mission/reviews.go
export type ReviewMerge = "clean" | "behind" | "conflicts" | "blocked" | "failing" | "unknown";
export type ReviewReportState = "present" | "missing" | "unknown";
export type ReviewCheckState = CheckState | "none";

export type ReviewCheck = { name: string; state: CheckState; local?: boolean };

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
    ci: ReviewCi;
    report: ReviewReport;
    unpublished: number;
};

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
    }
    return { label: t("reviews.merge.pending"), tone: "neutral", title: t("reviews.merge.pendingTitle") };
}

// validateBlocked is why a row's Validate cannot open the sheet, "" when it can (#683). It names the checks the Validate
// plan fails on and the row already knows (pkg/molten/review/merge.go's evaluate); running checks and a merge state
// still computing do not block: the sheet waits for them.
export function validateBlocked(pr: ReviewPr): string {
    if (pr.draft) {
        return t("reviews.validate.draft");
    }
    if (pr.merge === "conflicts") {
        return t("reviews.validate.conflicts", { base: pr.base });
    }
    if (pr.merge === "blocked") {
        return t("reviews.validate.blocked");
    }
    if (pr.ci?.state === "failure") {
        return t("reviews.validate.failing", { count: pr.ci.failure });
    }
    return "";
}

// A rebase asked from a row: to whom, and on which head. It shows until the PR's head changes (the agent pushed).
export type RebaseAsk = { name: string; head: string; at: number };

export function rebaseAskKey(dir: string, number: number): string {
    return `${dir}#${number}`;
}

export function rebaseAskShown(ask: RebaseAsk, pr: ReviewPr): boolean {
    if (ask == null) {
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
    agent?: string;
    agentname?: string;
    firstname?: string;
    briefpath?: string;
};

// asked: the agent has it (name), note when the developer still has a step; offer: no agent on the branch, the row
// offers to start one; info and failed: a line.
export type RebaseOutcome = {
    kind: "asked" | "offer" | "info" | "failed";
    name?: string;
    text: string;
    note?: boolean;
};

function folderOf(path: string): string {
    const parts = (path ?? "").split(/[/\\]/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? "";
}

export function rebaseOutcome(result: RebaseResult, error?: string): RebaseOutcome {
    if (error) {
        return { kind: "failed", text: t("reviews.rebase.failed", { message: error }) };
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
        message: serverText(result.messagetext, result.message ?? ""),
    };
    switch (result.status) {
        case "sent":
        case "started":
            return { kind: "asked", name, text: t("reviews.rebase.asked", vars) };
        case "typed":
            return { kind: "asked", name, text: t("reviews.rebase.typed", vars), note: true };
        case "offer":
            return { kind: "offer", text: t("reviews.rebase.offer", vars) };
        case "noagent":
            return { kind: "failed", text: t("reviews.rebase.noagent", vars) };
        case "busy":
            switch (result.reason) {
                case "agentbusy":
                    return {
                        kind: "info",
                        text:
                            result.agentstate === "waiting"
                                ? t("reviews.rebase.waiting", vars)
                                : t("reviews.rebase.working", vars),
                    };
                case "inflight":
                    return { kind: "info", text: t("reviews.rebase.inflight") };
            }
            return { kind: "info", text: t("reviews.rebase.notready", vars) };
    }
    switch (result.reason) {
        case "maincheckout":
            return { kind: "failed", text: t("reviews.rebase.maincheckout", vars) };
        case "terminal":
            return { kind: "failed", text: t("reviews.rebase.terminal") };
    }
    return { kind: "failed", text: t("reviews.rebase.failed", vars) };
}

export function ciLabel(ci: ReviewCi): { label: string; tone: Tone; title: string } {
    const checks = ci?.checks ?? [];
    const title = checks.map((c) => `${c.name}: ${c.state}`).join("\n") || t("reviews.ci.noneTitle");
    if (checks.length === 0) {
        return { label: t("reviews.ci.none"), tone: "neutral", title };
    }
    const parts: string[] = [];
    if (ci.failure > 0) {
        parts.push(t("reviews.ci.failing", { count: ci.failure }));
    }
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

export type ReviewCounts = { toreview: number; mergeable: number };

// mergeableNow: GitHub says the PR merges cleanly (#683) and no check fails or still runs.
export function mergeableNow(pr: ReviewPr): boolean {
    if (pr.draft || pr.merge !== "clean") {
        return false;
    }
    const ci = pr.ci?.state ?? "none";
    return ci === "success" || ci === "none";
}

// The rail's counts (#688, #775): the PRs waiting for review (the list's ready group) split in two disjoint sets that
// add up to them, those that cannot merge yet and those that can merge now. Nothing while GitHub could not be read:
// no badge then.
export function reviewCounts(answer: ReviewsAnswer, readied?: ReadiedPrs): ReviewCounts {
    if (answer?.state !== "ok") {
        return { toreview: 0, mergeable: 0 };
    }
    const ready = splitReviews(answer, readied).ready;
    const mergeable = ready.filter(mergeableNow).length;
    return { toreview: ready.length - mergeable, mergeable };
}

export function railCountText(count: number): string {
    return count > 99 ? "99+" : String(count);
}

function plural(n: number, key: string): string {
    return t(n === 1 ? `${key}.one` : `${key}.other`, { count: n });
}

// The Reviews icon's tooltip and accessible name: "Reviews — 5 to review, 4 ready to merge".
export function reviewsRailLabel(counts: ReviewCounts): string {
    if (counts == null || (counts.toreview === 0 && counts.mergeable === 0)) {
        return t("rail.tools.reviews");
    }
    const parts: string[] = [];
    if (counts.toreview > 0) {
        parts.push(plural(counts.toreview, "rail.tools.reviewsCount.toReview"));
    }
    if (counts.mergeable > 0) {
        parts.push(plural(counts.mergeable, "rail.tools.reviewsCount.mergeable"));
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

// markReadyError words a failed Mark ready for review in plain words, "" when it succeeded (#687).
export function markReadyError(result: MarkReadyResult, error?: string): string {
    if (error) {
        return t("reviews.ready.failed.error", { message: error });
    }
    if (result?.status === "ready") {
        return "";
    }
    switch (result?.reason) {
        case "closed":
            return t("reviews.ready.failed.closed");
        case "permission":
            return t("reviews.ready.failed.permission");
        case "auth":
            return t("reviews.ready.failed.auth");
        case "notfound":
            return t("reviews.ready.failed.notfound");
        case "nogh":
            return t("reviews.ready.failed.nogh");
    }
    return t("reviews.ready.failed.error", { message: result?.message ?? "" });
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
