// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the collector in wavesrv answers (pkg/molten/mission), and its translation into the shapes the ported Notulia
// modules read. Kept apart from the components so the rules can be tested without the app.

import { t } from "../i18n/i18n";
import { DefaultTagPrefix } from "../releases/versions";
import { GithubRelease, Milestone, PullRequest, WorkflowRun } from "./github";
import { labelRecord } from "./mission-i18n";

export type RawCommit = {
    sha: string;
    date: string;
    subject: string;
    // Only on the long-lived branches' commits (see Commit in pkg/molten/mission/git.go).
    parents?: string[];
    authordate?: string;
};

export type RawTag = {
    name: string;
    sha: string;
    date: string;
    notes: string | null;
    notesInternal: string | null;
};

export type RawBranch = {
    name: string;
    sha: string;
    date: string;
    commits: RawCommit[];
    fork: { sha: string; date: string } | null;
};

// The project's history as the release state reads it.
export type TreeData = {
    branches: RawBranch[];
    tags: RawTag[];
    // The branch work is merged into (develop in a git-flow project).
    trunk: string;
    // The branch releases are cut from (main); the same as the trunk in a single-branch project.
    release: string;
    // The project's release tags start with it (versions.tagprefix).
    tagPrefix?: string;
    // versions.firstpublic: tags below its first candidate are not the project's releases.
    firstPublic?: string;
};

export type MissionTag = { name: string; sha: string; date: string; notes?: string; notesinternal?: string };

// must match Merge in pkg/molten/mission/git.go
export type MissionMerge = {
    sha: string;
    date: string;
    subject: string;
    fork: { sha: string; date: string };
    commits: number;
    firstdate?: string;
};

export type MissionBranch = {
    name: string;
    sha: string;
    date: string;
    commits: RawCommit[];
    fork: { sha: string; date: string };
    // An agent tool's worktree branch with commits of its own (#1123); the empty ones are left out by wavesrv.
    agenttree?: boolean;
    // The linked worktree that has it checked out (#1133), the main checkout aside.
    worktree?: string;
};

export type MissionGit = {
    trunk: string;
    release: string;
    current?: string;
    remoteurl?: string;
    branches: MissionBranch[];
    tags: MissionTag[];
    merges?: MissionMerge[];
    ahead: RawCommit[];
    lastpublic?: string;
    sincepublic: RawCommit[];
    fetcherror?: string;
    tagprefix?: string;
    firstpublic?: string;
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

// must match PipelineReleasePhases in pkg/molten/pipeline.go
export type ReleasePhase = "prepare" | "cut" | "build" | "publish" | "back";

export type PipelineReleaseStep = PipelineCommand & {
    id: string;
    title?: string;
    phase?: ReleasePhase;
    confirm?: string;
    notes?: boolean;
    // Done by hand (FR-MC-037): the instructions, no run.
    manual?: string;
    // What proves a manual step done (#1095).
    check?: { path: string; contains: string };
};

// must match PipelineDependency in pkg/molten/pipeline.go
export type PipelineDependency = {
    project: string;
    paths: string[];
    branch?: string;
    sync?: string;
    output: string[];
};

// must match PipelineAdapterStep in pkg/molten/pipeline.go
export type PipelineAdapterStep = PipelineCommand & {
    id: string;
    title: string;
    section: string;
    // The environment a cd step deploys to (#559).
    environment?: string;
    confirm?: boolean;
};

export type PipelineDef = {
    schema: number;
    name: string;
    group?: string;
    dependson?: PipelineDependency[];
    branches?: { trunk?: string; release?: string };
    versions?: {
        tagprefix?: string;
        notes?: string;
        firstpublic?: string;
        files?: { path: string; format: "json" | "regex"; keys?: string[][]; pattern?: string }[];
    };
    ci?: {
        jobs: (PipelineCommand & { name: string; title?: string; lane?: string; description?: string })[];
        prepare?: PipelineCommand;
        statuses?: string;
    };
    builds?: (PipelineCommand & {
        id: string;
        title?: string;
        artifact?: string;
        kind?: string;
        description?: string;
        manifest?: string;
        phases?: { id: string; title?: string; text?: string }[];
        verify?: string;
        prepare?: PipelineCommand;
    })[];
    release?: {
        rc?: PipelineReleaseStep[];
        public?: PipelineReleaseStep[];
    };
    steps?: PipelineAdapterStep[];
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
    // The branch pull requests target when .saasfoundry.json declares one (FR-REV-001).
    prtarget?: string;
    // The workflow files' names, sizes and times: the Jobs tab reads them again when it moves (#637).
    workflowsstamp?: string;
};

export function toTreeData(git: MissionGit): TreeData {
    return {
        trunk: git.trunk,
        release: git.release,
        tagPrefix: git.tagprefix || DefaultTagPrefix,
        firstPublic: git.firstpublic || "",
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
            return t("mc.github.state.nogh");
        case "loggedout":
            return t("mc.github.state.loggedout");
        case "norepo":
            return t("mc.github.state.norepo");
        case "error":
            return t("mc.github.state.error", {
                message: github.message ?? t("mc.common.unknownError"),
            });
    }
    return null;
}

export function formatAge(at: number, now: number): string {
    if (!at) {
        return t("mc.time.never");
    }
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 45) {
        return t("mc.time.justNow");
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return t("mc.time.minAgo", { count: minutes });
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return t("mc.time.hAgo", { count: hours });
    }
    return t("mc.time.dAgo", { count: Math.round(hours / 24) });
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
    closed?: boolean;
    commit?: string;
    buildkind?: string;
    preparing?: boolean;
    // A sync's source and watched branch (commit is that branch's tip), and once it ended with exit 0 whether its
    // output changed, with the files (FR-MC-030).
    source?: string;
    branch?: string;
    outcome?: DepSyncOutcome;
    changed?: string[];
    logsize: number;
};

// must match the DepSyncOutcome constants in pkg/molten/mission/depsync.go
export type DepSyncOutcome = "changed" | "nochange";

export type TrustedCommand = {
    kind: string;
    id: string;
    title?: string;
    run: string;
    cwd?: string;
    env?: Record<string, string>;
};

export type UntrustedInfo = { hash: string; commands: TrustedCommand[] };

// must match ManualCheckFailure in pkg/molten/mission/release_manual.go: what a manual release step's check did not
// find (#1095); nothing was recorded.
export type ManualCheckFailure = {
    path: string;
    contains: string;
    missing?: boolean;
    dir: string;
    // A public changelog section that does not mention these changes since the last public release (#1142).
    uncovered?: CoverageItem[];
    since?: string;
    version?: string;
};

// must match CoverageItem in pkg/molten/release/coverage.go: a ticket, or a commit claiming none (ticket absent).
export type CoverageItem = { ticket?: number; text: string; url?: string };

export type RunResult = { run?: RunRecord; untrusted?: UntrustedInfo; unproved?: ManualCheckFailure };

export type LogChunk = { text: string; size: number };

export const RunStateLabels: Record<RunState, string> = labelRecord("mc.run.state", [
    "running",
    "success",
    "failure",
    "cancelled",
    "lost",
]);

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

// The last lines a run printed, without terminal colours.
export function logTail(text: string, lines: number): string[] {
    return (text ?? "")
        .replace(AnsiRegex, "")
        .split(/\r?\n|\r/)
        .filter((l) => l.trim() !== "")
        .slice(-lines);
}

export type RunLogMode = "auto" | "full" | "hidden";

// A failure left alone for this long is no longer an alarm.
export const StaleRunMs = 24 * 60 * 60 * 1000;

// A run that did not succeed is stale when a later run of the same step succeeded, or when it ended long ago: the
// step is then shown quiet, its log one click away.
export function runStale(run: RunRecord, runs: readonly RunRecord[], now: number): boolean {
    if (run == null || run.state === "running" || run.state === "success") {
        return false;
    }
    if (
        (runs ?? []).some(
            (r) =>
                r.kind === run.kind && r.stepid === run.stepid && r.state === "success" && r.startedat > run.startedat
        )
    ) {
        return true;
    }
    return now - (run.finishedat || run.startedat) > StaleRunMs;
}

// "auto" shows the last lines of a run that is running or did not succeed, unless the user hid it (kept with the run
// record: `closed`) or it is stale; "hidden" is the choice made on this screen. A new run is a new record, so a new
// failure is never hidden.
export function runLogVisible(run: RunRecord, mode: RunLogMode, stale?: boolean): boolean {
    if (run == null || mode === "hidden") {
        return false;
    }
    if (mode === "full") {
        return true;
    }
    if (run.state === "running") {
        return true;
    }
    return run.state !== "success" && !run.closed && !stale;
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
