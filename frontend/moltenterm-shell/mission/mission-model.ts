// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the collector in wavesrv answers (pkg/molten/mission), and its translation into the shapes the ported Notulia
// modules read. Kept apart from the components so the rules can be tested without the app.

import { GithubRelease, Milestone, PullRequest, WorkflowRun } from "./github";
import { RawCommit, TreeData } from "./tree";

export type MissionTag = { name: string; sha: string; date: string; notes?: string; notesinternal?: string };

export type MissionBranch = {
    name: string;
    sha: string;
    date: string;
    commits: RawCommit[];
    fork: { sha: string; date: string };
};

export type MissionGit = {
    trunk: string;
    release: string;
    current?: string;
    remoteurl?: string;
    branches: MissionBranch[];
    tags: MissionTag[];
    ahead: RawCommit[];
    lastpublic?: string;
    sincepublic: RawCommit[];
    fetcherror?: string;
};

// must match the states in pkg/molten/mission/github.go
export type GithubState = "ok" | "nogh" | "loggedout" | "norepo" | "error";

export type MissionGithub = {
    state: GithubState;
    message?: string;
    repo?: string;
    url?: string;
    prs?: PullRequest[];
    runs?: WorkflowRun[];
    releases?: GithubRelease[];
    milestones?: Milestone[];
    workflows: { name: string; text: string }[];
    errors?: Record<string, string>;
};

export type PipelineCommand = { run: string; cwd?: string; env?: Record<string, string> };

export type PipelineDef = {
    schema: number;
    name: string;
    branches?: { trunk?: string; release?: string };
    versions?: { tagprefix?: string; notes?: string };
    ci?: { jobs: (PipelineCommand & { name: string; title?: string; lane?: string })[] };
    builds?: (PipelineCommand & { id: string; title?: string; artifact?: string })[];
    release?: {
        rc?: (PipelineCommand & { id: string; title?: string })[];
        public?: (PipelineCommand & { id: string; title?: string })[];
    };
    steps?: (PipelineCommand & { id: string; title: string; section: string })[];
};

// must match PipelineReport in pkg/molten/pipeline.go
export type PipelineReport = {
    path: string;
    present: boolean;
    valid: boolean;
    errors: string[];
    warnings: string[];
    pipeline?: PipelineDef;
};

export type MissionSnapshot = {
    dir: string;
    missing?: boolean;
    git?: MissionGit;
    giterror?: string;
    gitat?: number;
    github?: MissionGithub;
    githubat?: number;
    refreshing?: boolean;
    pipeline?: PipelineReport;
};

export function toTreeData(git: MissionGit): TreeData {
    return {
        trunk: git.trunk,
        release: git.release,
        branches: (git.branches ?? []).map((b) => ({ ...b, commits: b.commits ?? [], fork: b.fork ?? null })),
        tags: (git.tags ?? []).map((t) => ({
            name: t.name,
            sha: t.sha,
            date: t.date,
            notes: t.notes || null,
            notesInternal: t.notesinternal || null,
        })),
    };
}

// Why GitHub's sections are empty, in the words the panels show.
export function githubStateMessage(github: MissionGithub): string {
    switch (github?.state) {
        case "nogh":
            return "GitHub CLI (gh) is not installed: install it to see pull requests and runs.";
        case "loggedout":
            return "gh is logged out: run gh auth login in a terminal.";
        case "norepo":
            return "This project has no GitHub remote.";
        case "error":
            return `GitHub could not be read: ${github.message ?? "unknown error"}`;
    }
    return null;
}

export function formatAge(at: number, now: number): string {
    if (!at) {
        return "never";
    }
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 45) {
        return "just now";
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    return `${Math.round(hours / 24)} d ago`;
}

// The open pull requests by branch, so a limb of the tree can show its PR.
export function prsByBranch(prs: readonly PullRequest[]): Map<string, { number: number; url: string }> {
    return new Map((prs ?? []).map((pr) => [pr.headRefName, { number: pr.number, url: pr.url }]));
}

// How to start the molten-pipeline guide in each agent (`molten agent list` shows the same).
// must match the invocations in pkg/molten/agents.go
export const PipelineInvocations = [
    { agent: "Claude Code, Gemini CLI, Qwen Code", invocation: "/molten-pipeline" },
    { agent: "Codex", invocation: "$molten-pipeline" },
    { agent: "Kimi Code", invocation: "/skill:molten-pipeline" },
];

export type PipelineStage = "loading" | "absent" | "invalid" | "valid";

export function pipelineStage(report: PipelineReport): PipelineStage {
    if (report == null) {
        return "loading";
    }
    if (!report.present) {
        return "absent";
    }
    return report.valid ? "valid" : "invalid";
}

// The ci jobs grouped by lane, in the order the file gives them.
export function jobsByLane(pipeline: PipelineDef): { lane: string; jobs: PipelineDef["ci"]["jobs"] }[] {
    const lanes: { lane: string; jobs: PipelineDef["ci"]["jobs"] }[] = [];
    for (const job of pipeline?.ci?.jobs ?? []) {
        const lane = job.lane || "main";
        let entry = lanes.find((l) => l.lane === lane);
        if (entry == null) {
            entry = { lane, jobs: [] };
            lanes.push(entry);
        }
        entry.jobs.push(job);
    }
    return lanes;
}

// must match RunRecord in pkg/molten/mission/runs.go
export type RunState = "running" | "success" | "failure" | "cancelled" | "lost";

export type RunRecord = {
    id: string;
    dir: string;
    kind: string;
    stepid: string;
    title?: string;
    command: string;
    cwd?: string;
    artifact?: string;
    pid?: number;
    startedat: number;
    finishedat?: number;
    state: RunState;
    exit?: number;
    phases: string[];
    cancelled?: boolean;
    logsize: number;
};

export type TrustedCommand = {
    kind: string;
    id: string;
    title?: string;
    run: string;
    cwd?: string;
    env?: Record<string, string>;
};

export type UntrustedInfo = { hash: string; commands: TrustedCommand[] };

export type RunResult = { run?: RunRecord; untrusted?: UntrustedInfo };

export type LogChunk = { text: string; size: number };

export const RunStateLabels: Record<RunState, string> = {
    running: "running",
    success: "succeeded",
    failure: "failed",
    cancelled: "cancelled",
    lost: "interrupted",
};

// Puts a record from the event bus into the list the panel shows, newest first.
export function upsertRun(runs: readonly RunRecord[], run: RunRecord): RunRecord[] {
    const rest = (runs ?? []).filter((r) => r.id !== run.id);
    return [run, ...rest].sort((a, b) => b.startedat - a.startedat);
}

export function latestRun(runs: readonly RunRecord[], kind: string): RunRecord {
    return (runs ?? []).find((r) => r.kind === kind) ?? null;
}

// Terminal colour codes start with ESC: the regex has to match that control character.
// eslint-disable-next-line no-control-regex
const AnsiRegex = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

// The last lines a run printed, without colours or the exit marker the runner adds.
export function logTail(text: string, lines: number): string[] {
    return (text ?? "")
        .replace(AnsiRegex, "")
        .split(/\r?\n|\r/)
        .filter((l) => l.trim() !== "" && !/^exit=-?\d+$/.test(l.trim()))
        .slice(-lines);
}

export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    if (minutes === 0) {
        return `${seconds} s`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours === 0) {
        return `${minutes} min ${String(seconds % 60).padStart(2, "0")}`;
    }
    return `${hours} h ${String(minutes % 60).padStart(2, "0")}`;
}
