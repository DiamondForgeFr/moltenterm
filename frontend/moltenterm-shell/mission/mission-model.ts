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

export type MissionSnapshot = {
    dir: string;
    missing?: boolean;
    git?: MissionGit;
    giterror?: string;
    gitat?: number;
    github?: MissionGithub;
    githubat?: number;
    refreshing?: boolean;
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

// The request the user gives their coding agent when the project has no pipeline yet (FR-MC-008 builds on it).
export function pipelineRequest(dir: string): string {
    return [
        `Set up Moltenterm's Mission Control pipeline for the project in ${dir}.`,
        "Run `molten docs` and read the pipeline guide, detect the project's harness (.saasfoundry.json, AGENTS.md, CLAUDE.md)",
        "and follow its workflow; reuse the scripts and CI workflows the project already has, add only what is missing",
        "(local CI, local build, gold, release candidate, release), and write .molten/project.json last.",
    ].join(" ");
}
