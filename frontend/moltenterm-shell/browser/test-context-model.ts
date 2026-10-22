// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The test context of a local app (FR-BRW-017, DS-BRW-024, #962): which checkout, branch, commit and pull request the
// page of a browser tab is served from. wavesrv resolves it (pkg/molten/mission/testcontext.go); this file only reads
// which tabs ask and how the answer reads.

import { pathBaseName } from "../workspace-project";

// must match TestContextCommand in pkg/molten/mission/testcontext.go
export const TestContextCommand = "moltenmissiontestcontext";

// must match TestContext in pkg/molten/mission/testcontext.go
export type TestContextAnswer = {
    url: string;
    host: string;
    port: number;
    known: boolean;
    // Why the source is unknown: notlocal, noprocess, nofolder or norepo.
    unknown?: string;
    pid?: number;
    process?: string;
    cwd?: string;
    root?: string;
    project?: string;
    name?: string;
    worktree?: boolean;
    branch?: string;
    sha?: string;
    detached?: boolean;
    dirty?: boolean;
    ticket?: number;
    pr?: { number: number; title: string; url: string; draft?: boolean; ci?: string };
    prknown?: boolean;
    futurepr?: boolean;
    sameproject?: boolean;
    giterror?: string;
    at?: number;
};

export type LocalTarget = { host: string; port: number };

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// The same hosts as LocalAppTarget in testcontext.go: a page on this computer, by name or loopback address.
export function localAppTarget(url: string): LocalTarget {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    const local =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".test") ||
        host === "::1" ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    if (!local) {
        return null;
    }
    const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return { host, port };
}

// A tab asks once per server: the path and query of the page say nothing of where it is served from.
export function targetKey(target: LocalTarget): string {
    return target == null ? "" : `${target.host}:${target.port}`;
}

export function shortSha(sha: string): string {
    return (sha ?? "").slice(0, 7);
}

export type ChipTone = "pr" | "future" | "branch" | "unknown";

export type ChipView = { label: string; tone: ChipTone; title: string };

export function chipView(answer: TestContextAnswer, t: Translate): ChipView {
    if (answer == null) {
        return null;
    }
    if (!answer.known) {
        return {
            label: t("browser.testContext.unknown"),
            tone: "unknown",
            title: t("browser.testContext.chipTitleUnknown", { reason: reasonText(answer, t) }),
        };
    }
    const where = branchText(answer, t);
    const title = t("browser.testContext.chipTitle", { where, port: answer.port });
    if (answer.pr != null) {
        return { label: `${where} · #${answer.pr.number}`, tone: "pr", title };
    }
    if (answer.futurepr) {
        return { label: `${where} · ${t("browser.testContext.futurePr")}`, tone: "future", title };
    }
    return { label: where, tone: "branch", title };
}

// The branch, or on a detached HEAD the commit it is at.
export function branchText(answer: TestContextAnswer, t: Translate): string {
    if (answer.branch) {
        return answer.detached ? t("browser.testContext.detachedAt", { at: answer.branch }) : answer.branch;
    }
    if (answer.detached && answer.sha) {
        return t("browser.testContext.detachedAt", { at: shortSha(answer.sha) });
    }
    return t("browser.testContext.noBranch");
}

export function reasonText(answer: TestContextAnswer, t: Translate): string {
    switch (answer?.unknown) {
        case "noprocess":
            return t("browser.testContext.reason.noProcess", { port: answer.port });
        case "nofolder":
            return t("browser.testContext.reason.noFolder", { process: answer.process || `${answer.pid}` });
        case "norepo":
            return t("browser.testContext.reason.noRepo", { folder: answer.cwd ?? "" });
        default:
            return t("browser.testContext.reason.notLocal");
    }
}

export type DetailRow = { label: string; value: string; title?: string };

export function detailRows(answer: TestContextAnswer, t: Translate): DetailRow[] {
    const rows: DetailRow[] = [];
    if (answer.known) {
        const place = answer.worktree ? t("browser.testContext.worktree") : t("browser.testContext.folder");
        rows.push({ label: place, value: pathBaseName(answer.root), title: answer.root });
        if (answer.name && answer.name !== pathBaseName(answer.root)) {
            rows.push({ label: t("browser.testContext.project"), value: answer.name, title: answer.project });
        }
        rows.push({ label: t("browser.testContext.branch"), value: branchText(answer, t) });
        if (answer.sha) {
            rows.push({
                label: t("browser.testContext.commit"),
                value: answer.dirty
                    ? t("browser.testContext.commitDirty", { sha: shortSha(answer.sha) })
                    : shortSha(answer.sha),
                title: answer.sha,
            });
        }
    }
    if (answer.pid) {
        rows.push({
            label: t("browser.testContext.served"),
            value: t("browser.testContext.servedBy", {
                process: answer.process || "?",
                pid: answer.pid,
                port: answer.port,
            }),
            title: answer.cwd,
        });
    }
    return rows;
}

// The PR line of the popover: its state, or why there is none.
export function prStateText(answer: TestContextAnswer, t: Translate): string {
    if (answer.pr != null) {
        return answer.pr.draft ? t("browser.testContext.prDraft") : t("browser.testContext.prReady");
    }
    if (answer.futurepr) {
        return t("browser.testContext.futurePrHint");
    }
    if (!answer.prknown) {
        return t("browser.testContext.prUnknown");
    }
    return t("browser.testContext.noPr");
}

// What "Open in Reviews" can do: the PR's card or the future PR's Upcoming entry, in the workspace's project only.
export type ReviewsTarget = { dir: string; number?: number; branch?: string };

export function reviewsTarget(answer: TestContextAnswer, workspaceDir: string): ReviewsTarget {
    if (!answer?.known || !answer.sameproject || !workspaceDir) {
        return null;
    }
    if (answer.pr != null) {
        return { dir: workspaceDir, number: answer.pr.number };
    }
    // The Upcoming section lists ticket branches only.
    if (answer.futurepr && answer.branch && (answer.ticket ?? 0) > 0) {
        return { dir: workspaceDir, branch: answer.branch };
    }
    return null;
}
