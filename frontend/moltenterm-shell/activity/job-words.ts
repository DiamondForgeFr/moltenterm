// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a sub-agent waits for, in plain words (#2502, FR-SHELL-018, FR-BOSS-009 AC85): wavesrv names each background
// command a sub-agent left running by its kind (pkg/molten/agentwork.go, from the program the command starts); the
// popover, the sidebar's lead row and the companion's Agents at work word it here, in the interface language. The
// command line itself never reaches a window. Pure over the translation function, so a test drives it with a fake.

import type { BackgroundJob } from "../agent-state-model";

type JobT = (key: string, vars?: Record<string, string | number>) => string;

// must match the Job* constants in pkg/molten/agentwork.go
export const JobKinds = [
    "vitest",
    "gotest",
    "tests",
    "affected",
    "buildfrontend",
    "buildbackend",
    "build",
    "perf",
    "check",
    "npmrun",
    "moltenci",
    "command",
] as const;

// What a sub-agent is said to wait for: "waiting for its tests:", "its build:", "its CI:", "its command:".
export type JobCategory = "tests" | "build" | "ci" | "command";

const CategoryOfKind: Record<string, JobCategory> = {
    vitest: "tests",
    gotest: "tests",
    tests: "tests",
    affected: "tests",
    check: "tests",
    buildfrontend: "build",
    buildbackend: "build",
    build: "build",
    perf: "build",
    moltenci: "ci",
};

export function jobCategory(kind: string): JobCategory {
    return CategoryOfKind[kind] ?? "command";
}

// "tests (vitest)", "frontend build", "npm script (lint)", "a command": a kind the window does not know is a command.
export function jobLabel(t: JobT, job: BackgroundJob): string {
    const kind = (JobKinds as readonly string[]).includes(job?.kind) ? job.kind : "command";
    if (kind === "npmrun") {
        return job.arg ? t("activity.job.npmrunArg", { script: job.arg }) : t("activity.job.npmrun");
    }
    return t(`activity.job.${kind}`);
}

// The job a sub-agent is named by: the oldest one, and how many more wait beside it.
export type JobsView = { label: string; since: number; more: number; category: JobCategory };

export function jobsView(t: JobT, jobs: readonly BackgroundJob[]): JobsView {
    const list = (jobs ?? []).filter((job) => job != null);
    if (list.length === 0) {
        return null;
    }
    const first = list[0];
    return {
        label: jobLabel(t, first),
        since: first.since ?? 0,
        more: list.length - 1,
        category: jobCategory(first.kind),
    };
}

// "waiting for its tests:" for a sub-agent whose turn ended on a job; without a known job, on its background work.
export function waitingWords(t: JobT, category: JobCategory | null): string {
    return t(category == null ? "activity.sub.waitingWork" : `activity.sub.waiting.${category}`);
}

// A sub-agent's task starts with its ticket ("#2496 tree scans"): the number has a place of its own on a row, and the
// rest is the title. A "#N" anywhere else names another ticket as often as its own, and never counts.
const LeadingTicket = /^\s*#(\d{1,9})\b/;
const LeadingTicketText = /^\s*#\d{1,9}\b[\s:.\-–—)]*/;

export function subagentTicket(description: string): number {
    const m = LeadingTicket.exec(description ?? "");
    return m == null ? 0 : Number(m[1]);
}

export function subagentTaskTitle(description: string): string {
    return (description ?? "").replace(LeadingTicketText, "").trim();
}

// The job as one line: "tests (vitest) · +1", its age is shown beside by the caller.
export function jobLine(t: JobT, view: JobsView): string {
    return view.more > 0 ? t("activity.sub.jobMore", { job: view.label, count: view.more }) : view.label;
}
