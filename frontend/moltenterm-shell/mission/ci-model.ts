// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The local CI's data on the panel side (FR-MC-011): mirrors pkg/molten/mission/ci.go. Kept apart from the components
// so the rules can be tested without the app.

export type CiStatus = "running" | "success" | "failure" | "cancelled" | "interrupted" | "queued";
export type CiVerdictStatus = "success" | "failure" | "missing" | "running";

export type CiJobRecord = {
    name: string;
    title?: string;
    lane?: string;
    status: CiStatus;
    startedat?: number;
    finishedat?: number;
    exit?: number;
};

export type CiRunRecord = {
    id: string;
    dir: string;
    sha: string;
    tree: string;
    branch?: string;
    startedat: number;
    finishedat?: number;
    status: CiStatus;
    force?: boolean;
    only?: string[];
    jobs: CiJobRecord[];
    error?: string;
};

export type CiBranch = { name: string; sha: string; date: number; verdict: CiVerdictStatus };

export type CiState = { runs: CiRunRecord[]; running?: string; branches: CiBranch[]; current?: string };

export const CiPrepareJob = "prepare";

export const CiStatusLabels: Record<CiStatus, string> = {
    running: "running",
    success: "passed",
    failure: "failed",
    cancelled: "cancelled",
    interrupted: "interrupted",
    queued: "waiting",
};

export function upsertCiRun(runs: CiRunRecord[], run: CiRunRecord): CiRunRecord[] {
    const rest = (runs ?? []).filter((r) => r.id !== run.id);
    return [run, ...rest].sort((a, b) => b.startedat - a.startedat);
}

// The job a run opens on: the one picked, else the failed one, else the running one, else the first.
export function defaultCiJob(run: CiRunRecord, picked: string): string {
    if (run == null) {
        return null;
    }
    if (picked && (picked === CiPrepareJob || run.jobs.some((j) => j.name === picked))) {
        return picked;
    }
    if (run.error) {
        return CiPrepareJob;
    }
    return (
        run.jobs.find((j) => j.status === "failure")?.name ??
        run.jobs.find((j) => j.status === "running")?.name ??
        run.jobs[0]?.name ??
        CiPrepareJob
    );
}

export function branchMark(verdict: CiVerdictStatus): string {
    switch (verdict) {
        case "success":
            return " ✓";
        case "failure":
            return " ✗";
        case "running":
            return " …";
    }
    return "";
}

export function shortSha(sha: string): string {
    return (sha ?? "").slice(0, 7);
}

export function formatCiDuration(ms: number): string {
    if (!(ms >= 0)) {
        return "";
    }
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    }
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function ciRunDuration(run: Pick<CiRunRecord, "startedat" | "finishedat">, now: number): number {
    return (run.finishedat || now) - run.startedat;
}

export type AnsiSegment = { text: string; color?: string; bold?: boolean; dim?: boolean };

// Colours for the log pane, which is always dark.
const AnsiColors = [
    "#6b7280",
    "#f87171",
    "#4ade80",
    "#facc15",
    "#60a5fa",
    "#c084fc",
    "#22d3ee",
    "#e5e7eb",
    "#9ca3af",
    "#fca5a5",
    "#86efac",
    "#fde047",
    "#93c5fd",
    "#d8b4fe",
    "#67e8f9",
    "#ffffff",
];

// Splits a log into styled segments from its SGR colour codes; every other control sequence is dropped.
export function parseAnsi(text: string): AnsiSegment[] {
    const segments: AnsiSegment[] = [];
    let style: Omit<AnsiSegment, "text"> = {};
    // eslint-disable-next-line no-control-regex
    const pattern = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r(?!\n)/g;
    let last = 0;
    const push = (chunk: string) => {
        if (chunk === "") {
            return;
        }
        const prev = segments[segments.length - 1];
        if (prev && prev.color === style.color && !!prev.bold === !!style.bold && !!prev.dim === !!style.dim) {
            prev.text += chunk;
            return;
        }
        segments.push({ text: chunk, ...style });
    };
    for (const match of (text ?? "").matchAll(pattern)) {
        push(text.slice(last, match.index));
        last = match.index + match[0].length;
        if (match[2] !== "m") {
            continue;
        }
        const codes = match[1] === "" ? [0] : match[1].split(";").map((c) => Number(c));
        for (let i = 0; i < codes.length; i++) {
            const code = codes[i];
            if (code === 0) {
                style = {};
            } else if (code === 1) {
                style = { ...style, bold: true };
            } else if (code === 2) {
                style = { ...style, dim: true };
            } else if (code === 22) {
                style = { ...style, bold: false, dim: false };
            } else if (code === 39) {
                style = { ...style, color: undefined };
            } else if (code >= 30 && code <= 37) {
                style = { ...style, color: AnsiColors[code - 30] };
            } else if (code >= 90 && code <= 97) {
                style = { ...style, color: AnsiColors[code - 90 + 8] };
            } else if (code === 38 && codes[i + 1] === 5) {
                const n = codes[i + 2];
                style = { ...style, color: n < 16 ? AnsiColors[n] : undefined };
                i += 2;
            } else if (code === 38 && codes[i + 1] === 2) {
                const [r, g, b] = codes.slice(i + 2, i + 5);
                style = { ...style, color: `rgb(${r ?? 0}, ${g ?? 0}, ${b ?? 0})` };
                i += 4;
            }
        }
    }
    push((text ?? "").slice(last));
    return segments;
}
