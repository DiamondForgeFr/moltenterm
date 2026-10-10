// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The options MoltenTerm's own widgets declare in their command panel (FR-SHELL-049, DS-SHELL-090): where each lives
// (block meta for This panel, settings for All <kind>) and the pure rules the views apply. Kept apart from the views
// and the providers, so both read the same keys and the rules are tested without a window.

import type { DurableSession } from "./sessions/sessions-model";
import { checkPathInside } from "./workspace-project";

// Line map: the window (This panel over the project's remembered one) and its animation.
export const LineMapDaysMetaKey = "linemap:days";
export const LineMapAnimationKey = "linemap:animation";

// CI/CD: the runs the panel shows (its tab).
export const CicdRunsKey = "cicd:runs";
export const CicdRunsChoices = [
    { value: "local", label: "Local CI", icon: "laptop-code" },
    { value: "remote", label: "Remote CI", icon: "cloud" },
    { value: "cd", label: "CD", icon: "box" },
] as const;
export type CicdRuns = (typeof CicdRunsChoices)[number]["value"];
export const CicdRunsDefault: CicdRuns = "remote";

export function cicdRuns(value: unknown): CicdRuns {
    return CicdRunsChoices.some((c) => c.value === value) ? (value as CicdRuns) : CicdRunsDefault;
}

// Project: the branches its line map draws.
export const ProjectBranchesMetaKey = "project:branches";
export const ProjectBranchesChoices = [
    { value: "all", label: "All branches" },
    { value: "open", label: "Open branches" },
    { value: "merged", label: "Merged branches" },
] as const;
export type ProjectBranches = (typeof ProjectBranchesChoices)[number]["value"];
export const ProjectBranchesDefault: ProjectBranches = "all";

export function projectBranches(value: unknown): ProjectBranches {
    return ProjectBranchesChoices.some((c) => c.value === value) ? (value as ProjectBranches) : ProjectBranchesDefault;
}

export function filterBranches<T extends { state: "merged" | "open" }>(branches: T[], filter: unknown): T[] {
    const f = projectBranches(filter);
    if (f === "all") {
        return branches;
    }
    return (branches ?? []).filter((b) => b.state === f);
}

// Sessions: what the list shows, by agent, folder and state.
export const SessionsAgentMetaKey = "sessions:agent";
export const SessionsFolderMetaKey = "sessions:folder";
export const SessionsStateMetaKey = "sessions:state";

export const SessionsAgentChoices = [
    { value: "all", label: "Any" },
    { value: "agents", label: "Agents only" },
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "shells", label: "Shells only" },
] as const;
export const SessionsFolderChoices = [
    { value: "all", label: "Any folder" },
    { value: "workspace", label: "This workspace's folder" },
] as const;
export const SessionsStateChoices = [
    { value: "all", label: "Any" },
    { value: "waiting", label: "Waiting" },
    { value: "working", label: "Working" },
    { value: "idle", label: "Idle" },
    { value: "hidden", label: "Not in a pane" },
] as const;

export type SessionsFilters = { agent?: unknown; folder?: unknown; state?: unknown };

function pick<T extends readonly { value: string }[]>(choices: T, value: unknown): T[number]["value"] {
    return choices.some((c) => c.value === value) ? (value as T[number]["value"]) : "all";
}

export function sessionsFiltered(filters: SessionsFilters): boolean {
    return (
        pick(SessionsAgentChoices, filters?.agent) !== "all" ||
        pick(SessionsFolderChoices, filters?.folder) !== "all" ||
        pick(SessionsStateChoices, filters?.state) !== "all"
    );
}

// The workspace's folder decides the folder filter; a remote session's folder is on another machine, so it never
// counts as inside a local folder.
export function filterSessions(
    sessions: DurableSession[],
    filters: SessionsFilters,
    workspaceFolder: string
): DurableSession[] {
    const agent = pick(SessionsAgentChoices, filters?.agent);
    const folder = pick(SessionsFolderChoices, filters?.folder);
    const state = pick(SessionsStateChoices, filters?.state);
    return (sessions ?? []).filter((s) => {
        if (agent === "agents" && !s.agent) {
            return false;
        }
        if (agent === "shells" && s.agent) {
            return false;
        }
        if ((agent === "claude" || agent === "codex") && s.agent !== agent) {
            return false;
        }
        if (folder === "workspace" && (s.connection || !checkPathInside(s.folder, workspaceFolder))) {
            return false;
        }
        if (state === "hidden") {
            return !s.shown;
        }
        if (state !== "all" && (!s.agent || (s.agentstate || "idle") !== state)) {
            return false;
        }
        return true;
    });
}
