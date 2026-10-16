// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The conflict forecast's data (FR-REV-023, DS-REV-016): wavesrv simulates the merges (pkg/molten/review/forecast.go,
// pkg/molten/forecast); this side builds the request from the Reviews list and reads the answer. Pure helpers, so the
// suggested merge order (#781) and the batch merge (#782) can reuse them.

import { t } from "../i18n/i18n";
import type { ReviewPr, ReviewsAnswer, ReviewsSplit } from "./reviews-model";

// must match pkg/molten/review/forecast.go
export const ForecastCommand = "moltenreviewforecast";
export const ForecastEvent = "molten:review:forecast";

export type ForecastMethod = "merge" | "squash" | "rebase";
export type ForecastUpToDate = "required" | "notrequired" | "unknown";
export type ForecastRowState = "simulated" | "conflictsbase" | "missing";

// must match forecast.Pr in pkg/molten/forecast/forecast.go
export type ForecastPr = { number: number; branch: string; headoid: string; ready?: boolean };

export type ForecastRequest = {
    dir: string;
    repo: string;
    base: string;
    baseoid: string;
    prs: ForecastPr[];
    force?: boolean;
};

// must match forecast.Impact
export type ForecastImpact = { number: number; headoid: string; paths: string[]; pathcount: number };

// must match forecast.Row
export type ForecastRow = {
    number: number;
    headoid: string;
    state: ForecastRowState;
    impacts: ForecastImpact[];
    basepaths?: string[];
};

// must match Forecast in pkg/molten/review/forecast.go
export type Forecast = {
    dir: string;
    repo?: string;
    base?: string;
    baseoid?: string;
    key: string;
    state: "" | "ready" | "failed";
    running?: boolean;
    stale?: boolean;
    method?: ForecastMethod;
    approximate?: boolean;
    uptodate?: ForecastUpToDate;
    rows: ForecastRow[];
    stats?: { merges: number; pairs: number; reused: number; fetched: number };
    error?: "" | "nogit" | "base" | "failed" | "toomany";
    message?: string;
    at?: number;
    ms?: number;
};

// The base commit the PRs are compared on: the one most of them report (they are read at the same moment).
export function forecastBaseOid(prs: ReviewPr[]): string {
    const counts = new Map<string, number>();
    let best = "";
    for (const pr of prs) {
        if (!pr.baseoid) {
            continue;
        }
        const n = (counts.get(pr.baseoid) ?? 0) + 1;
        counts.set(pr.baseoid, n);
        if (n > (counts.get(best) ?? 0)) {
            best = pr.baseoid;
        }
    }
    return best;
}

// forecastRequestOf is what the list asks: the ready PRs are simulated, the drafts only checked on top of them. null
// when there is nothing to forecast (no repository, no base commit, fewer than two PRs, nothing ready).
export function forecastRequestOf(answer: ReviewsAnswer, split: ReviewsSplit): ForecastRequest {
    if (answer?.state !== "ok" || !answer.repo || !answer.target || split == null) {
        return null;
    }
    const ready = split.ready.filter((pr) => pr.headoid && pr.branch);
    const drafts = split.drafts.filter((pr) => pr.headoid && pr.branch);
    const baseoid = forecastBaseOid([...split.ready, ...split.drafts]);
    if (ready.length === 0 || ready.length + drafts.length < 2 || !baseoid) {
        return null;
    }
    const prs: ForecastPr[] = [
        ...ready.map((pr) => ({ number: pr.number, branch: pr.branch, headoid: pr.headoid, ready: true })),
        ...drafts.map((pr) => ({ number: pr.number, branch: pr.branch, headoid: pr.headoid })),
    ];
    return { dir: answer.dir, repo: answer.repo, base: answer.target, baseoid, prs };
}

// forecastKey mirrors ForecastKey in pkg/molten/review/forecast.go: an answer is about the list shown when the keys match.
export function forecastKey(req: ForecastRequest): string {
    if (req == null) {
        return "";
    }
    const parts = req.prs.map((pr) => `${pr.number}@${pr.headoid}${pr.ready ? "r" : ""}`).sort();
    return `${req.base}@${req.baseoid}|${parts.join(",")}`;
}

// A forecast row usable for the list shown: the forecast is about the same base and the row about the same head. A
// stale forecast keeps showing what still holds while the next one runs.
export function rowOf(forecast: Forecast, pr: ReviewPr, baseoid: string): ForecastRow {
    if (forecast == null || pr == null || forecast.state !== "ready" || forecast.baseoid !== baseoid) {
        return null;
    }
    const row = forecast.rows?.find((r) => r.number === pr.number);
    if (row == null || row.headoid !== pr.headoid) {
        return null;
    }
    return row;
}

// impactsOf: the PRs merging pr would put in conflict, among those listed (the ready ones and the drafts) with the
// head the forecast saw.
export function impactsOf(forecast: Forecast, pr: ReviewPr, listed: ReviewPr[]): ForecastImpact[] {
    const row = rowOf(forecast, pr, forecastBaseOid(listed));
    if (row == null || row.state !== "simulated") {
        return [];
    }
    return (row.impacts ?? []).filter((impact) =>
        listed.some((other) => other.number === impact.number && other.headoid === impact.headoid)
    );
}

// impactedBy: the listed PRs whose merge would put pr in conflict, with the conflicting paths.
export function impactedBy(
    forecast: Forecast,
    pr: ReviewPr,
    listed: ReviewPr[]
): { number: number; paths: string[]; pathcount: number }[] {
    if (forecast?.state !== "ready" || pr == null) {
        return [];
    }
    const rtn: { number: number; paths: string[]; pathcount: number }[] = [];
    for (const other of listed) {
        if (other.number === pr.number) {
            continue;
        }
        const impact = impactsOf(forecast, other, listed).find((i) => i.number === pr.number);
        if (impact != null) {
            rtn.push({ number: other.number, paths: impact.paths, pathcount: impact.pathcount });
        }
    }
    return rtn;
}

function plural(n: number, key: string, vars: Record<string, string | number> = {}): string {
    return t(n === 1 ? `${key}.one` : `${key}.other`, { count: n, ...vars });
}

// pathsText lists the conflicting paths, "and N more" past the shown ones.
export function pathsText(paths: string[], pathcount: number, shown = 3): string {
    const list = (paths ?? []).slice(0, shown);
    const more = Math.max(pathcount ?? 0, paths?.length ?? 0) - list.length;
    const text = list.join(", ");
    return more > 0 ? t("reviews.forecast.pathsMore", { paths: text, count: more }) : text;
}

export type ForecastMark = { count: number; label: string; title: string; aria: string };

// The row's mark (AC-1, AC-2): none when the merge leaves every other PR mergeable.
export function forecastMark(impacts: ForecastImpact[]): ForecastMark {
    if (impacts == null || impacts.length === 0) {
        return null;
    }
    const count = impacts.length;
    const lines = impacts.map((i) =>
        t("reviews.forecast.markLine", { number: i.number, paths: pathsText(i.paths, i.pathcount, 5) })
    );
    return {
        count,
        label: String(count),
        title: [plural(count, "reviews.forecast.markTitle"), ...lines].join("\n"),
        aria: plural(count, "reviews.forecast.markAria"),
    };
}

// The note of a PR another merge would put in conflict: "Conflicts after #12 on src/a.ts".
export function impactedNote(by: { number: number; paths: string[]; pathcount: number }[]): string {
    if (by == null || by.length === 0) {
        return "";
    }
    return by
        .map((b) => t("reviews.forecast.impacted", { number: b.number, paths: pathsText(b.paths, b.pathcount) }))
        .join(" · ");
}

export type ForecastStatusKind = "none" | "computing" | "stale" | "failed" | "ready";
export type ForecastStatus = { kind: ForecastStatusKind; text: string; title: string };

const MethodKeys: Record<ForecastMethod, string> = {
    merge: "reviews.forecast.method.merge",
    squash: "reviews.forecast.method.squash",
    rebase: "reviews.forecast.method.rebase",
};

// The list's forecast line: computing, stale while a new one runs, could not run, or what it simulated.
export function forecastStatus(forecast: Forecast, req: ForecastRequest): ForecastStatus {
    if (req == null) {
        return { kind: "none", text: "", title: "" };
    }
    const fresh = forecast != null && forecast.key === forecastKey(req);
    if (forecast == null || (!fresh && !forecast.state)) {
        return {
            kind: "computing",
            text: t("reviews.forecast.computing"),
            title: t("reviews.forecast.computingTitle"),
        };
    }
    if (!fresh || forecast.stale) {
        return { kind: "stale", text: t("reviews.forecast.stale"), title: t("reviews.forecast.staleTitle") };
    }
    if (forecast.state === "failed") {
        const reason = t(`reviews.forecast.error.${forecast.error || "failed"}`, { max: 40 });
        return {
            kind: "failed",
            text: t("reviews.forecast.failed"),
            title: forecast.message ? `${reason}\n${forecast.message}` : reason,
        };
    }
    const method = t(MethodKeys[forecast.method] ?? MethodKeys.merge);
    const parts = [t("reviews.forecast.readyTitle", { method })];
    if (forecast.approximate) {
        parts.push(t("reviews.forecast.approximate"));
    }
    if (forecast.uptodate === "required") {
        parts.push(t("reviews.forecast.upToDateRequired"));
    }
    if (forecast.rows?.some((r) => r.state === "missing")) {
        parts.push(t("reviews.forecast.missing"));
    }
    return { kind: "ready", text: t("reviews.forecast.ready", { method }), title: parts.join("\n") };
}
