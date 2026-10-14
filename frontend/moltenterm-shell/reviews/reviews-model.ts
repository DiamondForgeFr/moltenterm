// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's data (FR-REV-001, DS-REV-001): wavesrv derives the list from Mission Control's collector
// (pkg/molten/mission/reviews.go); this side only words it. The pure helpers live here so they can be tested.

import { CheckState } from "../mission/github";

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

// FR-REV-001-AC2: clean, behind (GitHub rebases it at the merge), conflicts, blocked.
export function mergeLabel(merge: ReviewMerge, base: string): { label: string; tone: Tone; title: string } {
    switch (merge) {
        case "clean":
            return { label: "clean", tone: "success", title: "Can be rebased and merged as it is." };
        case "behind":
            return {
                label: "behind: will be rebased",
                tone: "pending",
                title: `Behind ${base}: it is rebased on ${base} at the merge.`,
            };
        case "conflicts":
            return {
                label: "conflicts",
                tone: "failure",
                title: `Conflicts with ${base}: the branch needs a rebase before it can be merged.`,
            };
        case "blocked":
            return {
                label: "blocked",
                tone: "failure",
                title: "GitHub blocks the merge: a required check or review is missing.",
            };
        case "failing":
            return { label: "checks failing", tone: "failure", title: "Mergeable, but some checks fail." };
    }
    return { label: "merge state pending", tone: "neutral", title: "GitHub is still computing the merge state." };
}

export function ciLabel(ci: ReviewCi): { label: string; tone: Tone; title: string } {
    const checks = ci?.checks ?? [];
    const title = checks.map((c) => `${c.name}: ${c.state}`).join("\n") || "No check reported on this pull request.";
    if (checks.length === 0) {
        return { label: "no checks", tone: "neutral", title };
    }
    const parts: string[] = [];
    if (ci.failure > 0) {
        parts.push(`${ci.failure} failing`);
    }
    if (ci.pending > 0) {
        parts.push(`${ci.pending} running`);
    }
    if (ci.success > 0) {
        parts.push(`${ci.success} passed`);
    }
    const tone: Tone =
        ci.state === "failure"
            ? "failure"
            : ci.state === "pending"
              ? "pending"
              : ci.state === "success"
                ? "success"
                : "neutral";
    return { label: `CI ${parts.join(", ") || `${checks.length} skipped`}`, tone, title };
}

export function reportLabel(report: ReviewReport): { label: string; tone: Tone; title: string } {
    switch (report?.state) {
        case "present":
            return {
                label: "test report",
                tone: "success",
                title: `Test report posted on the ${report.where === "ticket" ? "ticket" : "pull request"}: open it`,
            };
        case "missing":
            return {
                label: "no test report",
                tone: "pending",
                title: "No test report on the pull request or its ticket yet.",
            };
    }
    return { label: "test report…", tone: "neutral", title: "The test report is being looked for." };
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
        head.ticket ? `Ticket ${head.ticket}: ${head.title}` : head.title,
        `pull request #${pr.number}`,
        ciLabel(pr.ci).label,
        reportLabel(pr.report).label,
        mergeLabel(pr.merge, pr.base).label,
    ];
    if (pr.unpublished > 0) {
        parts.push(`${pr.unpublished} unpublished comment${pr.unpublished > 1 ? "s" : ""}`);
    }
    return parts.join(", ");
}

export type ReviewsEmpty = { icon: string; title: string; hint: string; details?: string };

// FR-REV-001-AC4: the GitHub states Mission Control knows (nogh, loggedout, norepo), with what to do.
export function reviewsEmptyState(answer: ReviewsAnswer): ReviewsEmpty {
    switch (answer?.state) {
        case "nogh":
            return {
                icon: "terminal",
                title: "GitHub CLI (gh) is not installed",
                hint: "Reviews reads your pull requests through your own gh: install it (cli.github.com), run gh auth login, then refresh.",
            };
        case "loggedout":
            return {
                icon: "right-to-bracket",
                title: "gh is logged out",
                hint: "Run gh auth login in a terminal, then refresh. MoltenTerm never asks for a token.",
            };
        case "norepo":
            return {
                icon: "code-branch",
                title: "This project has no GitHub remote",
                hint: "Reviews lists the pull requests of the project's GitHub repository: add its remote, or link the workspace to another folder.",
            };
        case "error":
            return {
                icon: "triangle-exclamation",
                title: "GitHub could not be read",
                hint: "gh could not answer. Try again in a moment.",
                details: answer.message,
            };
    }
    return null;
}

// The rows a keyboard walks: the ready ones, then the drafts when their group is open.
export function navigableRows(answer: ReviewsAnswer, draftsOpen: boolean): ReviewPr[] {
    if (answer == null) {
        return [];
    }
    return draftsOpen ? [...answer.ready, ...answer.drafts] : answer.ready;
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
