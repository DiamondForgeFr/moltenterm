// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A Review tab whose PR is finished (#686): merged from MoltenTerm (the review store's merge record), merged or closed
// on GitHub (the PR's state, read when it leaves the Reviews list). The header then shows a calm state in place of
// Validate, and the top tab a done mark, from the block's meta so every window's tab bar sees it.

import type { TFunction } from "../i18n/i18n";
import type { KnownMerge } from "../reviews/reviews-merges";
import type { ReviewCleanupResult } from "./review-cleanup";
import type { ReviewMergeRecord, ReviewPrStateResult } from "./review-client";

// The block meta key the tab bar reads (tab-identity.ts); its value is a ReviewDoneMeta, absent while the PR is open.
export const ReviewDoneMetaKey = "molten:reviewdone";

export type ReviewDoneKind = "open" | "merged" | "mergedgithub" | "closed";

export type ReviewDone = {
    kind: ReviewDoneKind;
    base?: string;
    oid?: string;
    // ms since the epoch
    at?: number;
    // who merged it, from the Reviews list's Recently merged; byyou: MoltenTerm merged it (#898)
    by?: string;
    byyou?: boolean;
};

export type ReviewDoneMeta = { state: "merged" | "closed" };

function githubTime(value: string): number {
    const at = Date.parse(value ?? "");
    return Number.isNaN(at) ? undefined : at;
}

// reviewDoneOf maps what is known of the PR to the header's state. A merge from MoltenTerm wins; GitHub's state covers a
// PR merged or closed elsewhere (a Validate refused because the PR was merged away included). known: the merge the
// Reviews list knows before GitHub's state is read (#898), a batch step's or one listed in Recently merged. Unknown
// reads as open.
export function reviewDoneOf(
    record: ReviewMergeRecord,
    github: ReviewPrStateResult,
    baseref: string,
    known?: KnownMerge
): ReviewDone {
    if (record?.state === "merged") {
        return {
            kind: "merged",
            base: baseref,
            oid: record.mergedoid || record.head,
            at: record.endedat || undefined,
            byyou: true,
        };
    }
    if (github?.state === "merged") {
        return {
            kind: "mergedgithub",
            base: github.baseref || known?.base || baseref,
            oid: github.mergedoid || known?.oid,
            at: githubTime(github.mergedat) ?? known?.at,
            by: known?.by,
            byyou: known?.byyou || undefined,
        };
    }
    if (known != null) {
        return {
            kind: "mergedgithub",
            base: known.base || baseref,
            oid: known.oid,
            at: known.at,
            by: known.by,
            byyou: known.byyou || undefined,
        };
    }
    if (github?.state === "closed") {
        return { kind: "closed", base: github.baseref || baseref, at: githubTime(github.closedat) };
    }
    return { kind: "open" };
}

export function isReviewDone(done: ReviewDone): boolean {
    return done != null && done.kind !== "open";
}

export function isReviewMerged(done: ReviewDone): boolean {
    return done?.kind === "merged" || done?.kind === "mergedgithub";
}

function bannerWhen(t: TFunction, at: number, locale: string, now: number): string {
    if (at == null) {
        return "";
    }
    const date = new Date(at);
    const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    if (date.toDateString() === new Date(now).toDateString()) {
        return t("review.done.banner.today", { time });
    }
    return t("review.done.banner.day", { date: date.toLocaleDateString(locale, { dateStyle: "medium" }), time });
}

// reviewMergedBanner is the line over a Review tab whose PR merged (#898): "Merged by you at 14:32, on develop". ""
// while the PR is not known merged.
export function reviewMergedBanner(t: TFunction, done: ReviewDone, locale: string, now = Date.now()): string {
    if (!isReviewMerged(done)) {
        return "";
    }
    const who = done.byyou ? t("review.done.banner.you") : (done.by ?? "");
    const when = bannerWhen(t, done.at, locale, now);
    const vars = { who, when, base: done.base ?? "" };
    if (who && when) {
        return t("review.done.banner.byWhen", vars);
    }
    if (who) {
        return t("review.done.banner.by", vars);
    }
    if (when) {
        return t("review.done.banner.when", vars);
    }
    return t("review.done.banner.plain", vars);
}

// The block meta the tab bar should see: null while the PR is open.
export function reviewDoneMeta(done: ReviewDone): ReviewDoneMeta {
    switch (done?.kind) {
        case "merged":
        case "mergedgithub":
            return { state: "merged" };
        case "closed":
            return { state: "closed" };
    }
    return null;
}

export function readReviewDoneMeta(value: unknown): ReviewDoneMeta {
    const state = (value as ReviewDoneMeta)?.state;
    return state === "merged" || state === "closed" ? { state } : null;
}

export function reviewDoneLabel(t: TFunction, done: ReviewDone): string {
    switch (done?.kind) {
        case "merged":
            return t("review.done.validated");
        case "mergedgithub":
            return done.byyou ? t("review.done.merged") : t("review.done.mergedGithub");
        case "closed":
            return t("review.done.closed");
    }
    return "";
}

function formatAt(at: number, locale: string): string {
    if (at == null) {
        return "";
    }
    return new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

// reviewDoneDetail is the hover of the header's state: where and when the PR was merged, or when it was closed.
export function reviewDoneDetail(t: TFunction, done: ReviewDone, locale: string): string {
    if (!isReviewDone(done)) {
        return "";
    }
    const time = formatAt(done.at, locale);
    if (done.kind === "closed") {
        return time ? t("review.done.closedAt", { time }) : t("review.done.closedTitle");
    }
    const vars = { base: done.base ?? "", oid: (done.oid ?? "").slice(0, 7), time };
    let key = "review.done.mergedInto";
    if (vars.oid && time) {
        key = "review.done.mergedIntoAtTime";
    } else if (vars.oid) {
        key = "review.done.mergedIntoAt";
    } else if (time) {
        key = "review.done.mergedIntoTime";
    }
    const detail = t(key, vars);
    return done.kind === "merged" ? `${detail}\n${t("review.done.showResult")}` : detail;
}

// The top tab's mark and its tooltip.
export function reviewDoneTabTitle(t: TFunction, meta: ReviewDoneMeta): string {
    if (meta == null) {
        return "";
    }
    return meta.state === "merged" ? t("review.done.tabMerged") : t("review.done.tabClosed");
}

export type MergedFooter = "cleaning" | "needs" | "failed" | "done";

// mergedFooter is what the Validate result's footer says once the PR is merged, when it proposes to close the tab:
// the cleanup still running, a kept worktree waiting for the developer, a failed step, or all done. null: no proposal.
export function mergedFooter(record: ReviewMergeRecord, cleanup: ReviewCleanupResult): MergedFooter {
    if (record?.state !== "merged") {
        return null;
    }
    if (record.cleanuprunning || cleanup == null) {
        return "cleaning";
    }
    const steps = cleanup.steps ?? [];
    if (steps.some((s) => s.state === "skipped" && (s.code === "kept" || s.code === "inuse"))) {
        return "needs";
    }
    if (steps.some((s) => s.state === "failed")) {
        return "failed";
    }
    return "done";
}

// shouldReadPrState says whether the tab asks GitHub for the PR's state: once when it opens, then whenever the PR is
// missing from a good Reviews answer, at most every recheckMs, and never again once the PR is known merged.
export function shouldReadPrState(
    known: ReviewPrStateResult,
    lastReadAt: number,
    now: number,
    recheckMs: number
): boolean {
    if (known?.state === "merged") {
        return false;
    }
    return lastReadAt == null || now - lastReadAt >= recheckMs;
}
