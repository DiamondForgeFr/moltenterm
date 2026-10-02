// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// GitHub as the CI remote tab shows it (FR-MC-002), ported from Notulia (src/lib/devGithub.ts, devCron.ts): open pull
// requests with their checks (GitHub's jobs and local-* statuses side by side), recent runs, and scheduled workflows
// with their next runs. The panel only looks: merging stays on GitHub, one click away.

export type CheckState = "success" | "failure" | "pending" | "neutral";

// One entry of `gh pr list --json statusCheckRollup`: a check run (a GitHub job) or a status context.
export type RollupEntry = {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
};

export type PullRequest = {
    number: number;
    title: string;
    body?: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
    createdAt: string;
    updatedAt: string;
    url: string;
    mergeStateStatus?: string;
    statusCheckRollup?: RollupEntry[];
    closingIssuesReferences?: { number: number }[];
};

export type WorkflowRun = {
    databaseId: number;
    workflowName: string;
    event: string;
    status: string;
    conclusion: string;
    headBranch: string;
    headSha?: string;
    displayTitle: string;
    createdAt: string;
    updatedAt: string;
    url: string;
};

export type GithubRelease = {
    tagName: string;
    name: string;
    isDraft: boolean;
    isPrerelease: boolean;
    isLatest: boolean;
    publishedAt: string;
    createdAt: string;
};

export type Milestone = {
    number: number;
    title: string;
    open_issues: number;
    closed_issues: number;
    due_on?: string;
    html_url: string;
};

export type CheckSummary = { name: string; state: CheckState; local: boolean };

const FailureWords = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const PendingWords = ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"];

function stateOf(entry: RollupEntry): CheckState {
    if (entry.status && entry.status.toUpperCase() !== "COMPLETED") {
        return "pending";
    }
    const word = (entry.conclusion ?? entry.state ?? "").toUpperCase();
    if (word === "SUCCESS") {
        return "success";
    }
    if (FailureWords.includes(word)) {
        return "failure";
    }
    if (PendingWords.includes(word)) {
        return "pending";
    }
    return "neutral";
}

// A pull request's checks, GitHub's first, each once (the latest wins).
export function summarizeChecks(rollup: readonly RollupEntry[]): CheckSummary[] {
    const byName = new Map<string, CheckSummary>();
    for (const entry of rollup ?? []) {
        const name = entry.name ?? entry.context ?? "";
        if (!name) {
            continue;
        }
        byName.set(name, { name, state: stateOf(entry), local: /^local-/.test(name) });
    }
    return [...byName.values()].sort((a, b) => Number(a.local) - Number(b.local) || a.name.localeCompare(b.name));
}

export function mergeStateLabel(state: string, base: string): { label: string; tone: CheckState } {
    switch ((state ?? "").toUpperCase()) {
        case "CLEAN":
            return { label: "ready to merge", tone: "success" };
        case "HAS_HOOKS":
            return { label: "ready (hooks)", tone: "success" };
        case "BLOCKED":
            return { label: "blocked: required checks", tone: "failure" };
        case "DIRTY":
            return { label: `conflicts with ${base}`, tone: "failure" };
        case "BEHIND":
            return { label: `behind ${base}`, tone: "pending" };
        case "UNSTABLE":
            return { label: "checks failing", tone: "failure" };
        case "DRAFT":
            return { label: "draft", tone: "neutral" };
    }
    return { label: "state being computed", tone: "pending" };
}

const EventLabels: Record<string, string> = {
    schedule: "scheduled",
    pull_request: "PR",
    push: "push",
    workflow_dispatch: "manual",
    release: "release",
};

export function eventLabel(event: string): string {
    return EventLabels[event] ?? event;
}

export function runState(status: string, conclusion: string): CheckState {
    return stateOf({ status: (status ?? "").toUpperCase(), conclusion });
}

export type ScheduledWorkflow = { file: string; name: string; crons: string[] };

// The workflows that run on a schedule, from their files: the top `name:` and every `- cron:` not commented out.
export function scheduledWorkflows(files: readonly { name: string; text: string }[]): ScheduledWorkflow[] {
    const out: ScheduledWorkflow[] = [];
    for (const { name: file, text } of files ?? []) {
        const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
        const name = lines.map((l) => /^name:\s*["']?(.+?)["']?\s*$/.exec(l)?.[1]).find(Boolean);
        const crons = lines
            .map((l) => /^\s*-\s*cron:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(l)?.[1]?.trim())
            .filter((c): c is string => Boolean(c));
        if (crons.length) {
            out.push({ file, name: name ?? file, crons });
        }
    }
    return out;
}

// Markdown as a line of reading: no headings, tables, code fences or emphasis; links keep their text.
export function plainText(markdown: string): string {
    return (markdown ?? "")
        .replace(/```[\s\S]*?```/g, "")
        .split("\n")
        .filter((l) => !/^\s*#/.test(l) && !/^\s*\|/.test(l))
        .map((l) =>
            l
                .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "• ")
                .replace(/^\s*[-*]\s+/, "• ")
                .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
                .replace(/[*_`]/g, "")
                .trim()
        )
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function section(markdown: string, headings: readonly string[]): string {
    for (const heading of headings) {
        const match = new RegExp(`^##+\\s*${heading}\\s*$`, "im").exec(markdown);
        if (!match) {
            continue;
        }
        const rest = markdown.slice(match.index + match[0].length);
        const end = rest.search(/^##+\s/m);
        return (end === -1 ? rest : rest.slice(0, end)).trim();
    }
    return null;
}

function clip(text: string, max = 420): string {
    return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

// What a pull request brings, from its own description: its "Summary" or "What changes" first.
export function prSummary(body: string): string {
    const text =
        section(body ?? "", ["Summary", "What changes", "What it does", "Why"]) ??
        (body ?? "").replace(/^(Closes|Resolves)[^\n]*\n/i, "");
    return clip(plainText(text)) || null;
}

type CronFields = {
    minutes: number[];
    hours: number[];
    days: number[];
    months: number[];
    weekdays: number[];
};

const CronNames: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};

function cronField(text: string, min: number, max: number): number[] {
    const values = new Set<number>();
    for (const part of text.toLowerCase().split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1) {
            return null;
        }
        const value = (v: string) => (v in CronNames ? CronNames[v] : Number(v));
        let from = min;
        let to = max;
        if (range !== "*") {
            const [a, b] = range.split("-");
            from = value(a);
            to = b === undefined ? (stepText === undefined ? from : max) : value(b);
        }
        if (![from, to].every((v) => Number.isInteger(v) && v >= min && v <= max) || from > to) {
            return null;
        }
        for (let v = from; v <= to; v += step) {
            values.add(v);
        }
    }
    return [...values].sort((x, y) => x - y);
}

export function parseCron(expression: string): CronFields {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
        return null;
    }
    const minutes = cronField(parts[0], 0, 59);
    const hours = cronField(parts[1], 0, 23);
    const days = parts[2] === "*" ? null : cronField(parts[2], 1, 31);
    const months = cronField(parts[3], 1, 12);
    const weekdays = parts[4] === "*" ? null : (cronField(parts[4], 0, 7)?.map((d) => d % 7) ?? null);
    if (!minutes || !hours || !months || (parts[2] !== "*" && !days) || (parts[4] !== "*" && !weekdays)) {
        return null;
    }
    return { minutes, hours, days, months, weekdays };
}

// The next runs after `from`, cron being read in UTC as GitHub does.
export function nextRuns(expression: string, from: Date, count: number): Date[] {
    const cron = parseCron(expression);
    if (!cron) {
        return [];
    }
    const runs: Date[] = [];
    const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    for (let day = 0; day < 800 && runs.length < count; day++) {
        const date = new Date(start + day * 86_400_000);
        if (!cron.months.includes(date.getUTCMonth() + 1)) {
            continue;
        }
        const dom = cron.days?.includes(date.getUTCDate());
        const dow = cron.weekdays?.includes(date.getUTCDay());
        // Cron's rule: both restricted, either may match; one restricted, that one.
        const dayOk = cron.days && cron.weekdays ? dom || dow : cron.days ? dom : cron.weekdays ? dow : true;
        if (!dayOk) {
            continue;
        }
        for (const h of cron.hours) {
            for (const m of cron.minutes) {
                const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m));
                if (t > from && runs.length < count) {
                    runs.push(t);
                }
            }
        }
    }
    return runs;
}

const DayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeCron(expression: string): string {
    const cron = parseCron(expression);
    if (!cron || cron.minutes.length !== 1 || cron.hours.length !== 1 || cron.months.length !== 12 || cron.days) {
        return `cron "${expression}"`;
    }
    const at = `${String(cron.hours[0]).padStart(2, "0")}:${String(cron.minutes[0]).padStart(2, "0")} UTC`;
    const days = cron.weekdays;
    let when: string;
    if (!days) {
        when = "every day";
    } else if (days.join() === "1,2,3,4,5") {
        when = "Monday to Friday";
    } else if (days.length === 1) {
        when = `every ${DayNames[days[0]]}`;
    } else {
        when = "on " + days.map((d) => DayNames[d]).join(", ");
    }
    return `${when} at ${at}`;
}
