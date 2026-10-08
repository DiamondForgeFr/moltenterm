// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the Project tab (FR-SHELL-015) shows, computed from what Mission Control already collects: the living branches
// with their local CI verdict and pull request, the agents of the workspace, the work in progress. Kept apart from the
// components so the rules can be tested without the app.

import { AgentStateInfo, agentStateUrgency } from "../agent-state-model";
import { CiBranch, CiRunRecord, CiState, CiVerdictStatus } from "../mission/ci-model";
import { CheckState, mergeStateLabel, PullRequest, summarizeChecks } from "../mission/github";
import { MissionGit, RunRecord } from "../mission/mission-model";
import { ReleaseSession } from "../mission/release-model";

// must match pkg/molten/mission/projecttab.go
export const ProjectTabCommand = "moltenmissionprojecttab";
export const ProjectTabMetaKey = "molten:projecttab";
export const ProjectTabDirMetaKey = "molten:projecttabdir";
// must match ProjectView in pkg/molten/mission/projecttab.go and ProjectOverviewView in pkg/molten/missionviews.go
export const MoltentermProjectView = "molten-project";
// The Timeline view, absorbed by the Project overview (FR-MC-020): saved layouts and notifications may still name it.
// must match LegacyTimelineView in pkg/molten/missionviews.go
export const LegacyTimelineView = "molten-timeline";

// The view to open for a view name a layout, a widget or a notification holds: the Timeline opens the Project view.
export function currentMissionView(view: string): string {
    return view === LegacyTimelineView ? MoltentermProjectView : view;
}

export type BranchRole = "trunk" | "release" | "feature";

export type BranchPr = {
    number: number;
    url: string;
    title: string;
    draft: boolean;
    merge: { label: string; tone: CheckState };
    checks: { passed: number; failed: number; pending: number };
};

export type BranchRow = {
    name: string;
    role: BranchRole;
    current: boolean;
    // Commits not on the trunk yet; null for the trunk itself.
    ahead: number;
    date: string;
    // The local CI's say on the branch's code (FR-MC-011); null when the local CI does not list the branch.
    ci: CiVerdictStatus;
    pr: BranchPr;
};

export type BranchRows = { rows: BranchRow[]; merged: number };

function branchPr(pr: PullRequest, trunk: string): BranchPr {
    if (pr == null) {
        return null;
    }
    const checks = { passed: 0, failed: 0, pending: 0 };
    for (const check of summarizeChecks(pr.statusCheckRollup)) {
        if (check.state === "success") {
            checks.passed++;
        } else if (check.state === "failure") {
            checks.failed++;
        } else if (check.state === "pending") {
            checks.pending++;
        }
    }
    return {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        draft: pr.isDraft,
        merge: mergeStateLabel(pr.isDraft ? "DRAFT" : pr.mergeStateStatus, pr.baseRefName || trunk),
        checks,
    };
}

// One row per living branch: the trunk and the release branch, then every branch with work not on the trunk or an
// open pull request, newest first. The others are merged: counted, for the Clean branches action.
export function projectBranchRows(
    git: MissionGit,
    ciBranches: readonly CiBranch[],
    prs: readonly PullRequest[],
    // The checked-out branch as the local CI read it, fresher than the collector's cached snapshot.
    current?: string
): BranchRows {
    if (git == null) {
        return { rows: [], merged: 0 };
    }
    const verdicts = new Map((ciBranches ?? []).map((b) => [b.name, b.verdict]));
    const prByBranch = new Map((prs ?? []).map((pr) => [pr.headRefName, pr]));
    const rows: BranchRow[] = [];
    let merged = 0;
    const row = (name: string, role: BranchRole, ahead: number, date: string): BranchRow => ({
        name,
        role,
        current: name === (current || git.current),
        ahead,
        date,
        ci: verdicts.get(name) ?? null,
        pr: branchPr(prByBranch.get(name), git.trunk),
    });
    const branches = git.branches ?? [];
    const named = (name: string) => branches.find((b) => b.name === name);
    const trunk = named(git.trunk);
    if (trunk) {
        rows.push(row(trunk.name, "trunk", null, trunk.date));
    }
    const release = git.release && git.release !== git.trunk ? named(git.release) : null;
    if (release) {
        rows.push(row(release.name, "release", null, release.date));
    }
    const features = branches
        .filter((b) => b.name !== git.trunk && b.name !== git.release)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    for (const b of features) {
        const ahead = (b.commits ?? []).length;
        if (ahead === 0 && !prByBranch.has(b.name)) {
            merged++;
            continue;
        }
        rows.push(row(b.name, "feature", ahead, b.date));
    }
    return { rows, merged };
}

export const BranchRowsShown = 12;

// The agents working in the workspace, most urgent first (waiting, error, working, done), then the longest-running.
export function workspaceAgents(states: Record<string, AgentStateInfo>, workspaceId: string): AgentStateInfo[] {
    return Object.values(states ?? {})
        .filter((s) => s != null && s.workspaceid === workspaceId)
        .sort(
            (a, b) =>
                agentStateUrgency(b.state) - agentStateUrgency(a.state) ||
                (a.since ?? 0) - (b.since ?? 0) ||
                a.blockid.localeCompare(b.blockid)
        );
}

export type WorkItem = {
    id: string;
    kind: "ci" | "build" | "release" | "step";
    label: string;
    detail: string;
    startedat: number;
};

// What runs for the project right now: the local CI run, the builds, the release on its way.
export function projectWork(ci: CiState, runs: readonly RunRecord[], release: ReleaseSession): WorkItem[] {
    const rtn: WorkItem[] = [];
    const ciRun: CiRunRecord = ci?.running ? (ci.runs ?? []).find((r) => r.id === ci.running) : null;
    if (ciRun) {
        const done = ciRun.jobs.filter((j) => j.status === "success").length;
        rtn.push({
            id: `ci:${ciRun.id}`,
            kind: "ci",
            label: `CI on ${ciRun.branch || "HEAD"}`,
            detail: `${done}/${ciRun.jobs.length} jobs`,
            startedat: ciRun.startedat,
        });
    }
    for (const run of runs ?? []) {
        if (run.state !== "running") {
            continue;
        }
        const kind = run.kind === "build" ? "build" : run.kind === "release" ? "release" : "step";
        rtn.push({
            id: `run:${run.id}`,
            kind,
            label: kind === "build" ? `Build ${run.title || run.stepid}` : run.title || run.stepid,
            detail: run.phases?.length ? run.phases[run.phases.length - 1] : "",
            startedat: run.startedat,
        });
    }
    if (release != null) {
        rtn.push({
            id: `release:${release.tag}`,
            kind: "release",
            label: `Release ${release.tag}`,
            detail: release.channel === "rc" ? "candidate" : "public",
            startedat: release.startedat,
        });
    }
    return rtn;
}

// Mission Control's views a build, CI or release notification points at: they land on the Project tab when the
// workspace has one (CI/CD stays one click away from it). Older notifications still name the Timeline.
export const MissionPanelViews = [MoltentermProjectView, LegacyTimelineView, "molten-cicd"];
export const ProjectNotificationSources = ["build", "ci", "release", "deps"];

export function checkProjectRoute(source: string, view: string): boolean {
    return ProjectNotificationSources.includes(source) && MissionPanelViews.includes(view);
}

// A build, CI or release notification that points at no pane of its own: clicking it shows the Project tab.
export function checkProjectSource(entry: { source: string; tabid?: string; blockid?: string }): boolean {
    return ProjectNotificationSources.includes(entry.source) && !entry.tabid && !entry.blockid;
}

// A pull request's address comes from gh's answer: only a web page is opened from it, never another scheme's handler.
export function checkWebUrl(url: string): boolean {
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}
