// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the agents of the projects not shown are doing (FR-SHELL-087, #1760): a project switch hides the other
// projects' views, never their agents, so the header and the project menu say which of them wait for you, work or
// failed. Kept apart from the components so the rules can be tested without the app.

import type { AgentStateInfo } from "../agent-state-model";
import { agentStateLabel } from "../agent-state-model";
import { tabProjectOf } from "../hidden-tabs";
import { t } from "../i18n/i18n";
import { projectOfFolder } from "./sidebar-agents-model";
import { currentProjectId, type WorkspaceProjectEntry } from "./workspace-projects";

// Most urgent first: this is the order the dots and the words come in.
export const ActivityStates = ["error", "waiting", "working", "done"] as const;

export type ActivityState = (typeof ActivityStates)[number];

export type ActivityCounts = Partial<Record<ActivityState, number>>;

export type ProjectActivity = { project: WorkspaceProjectEntry; counts: ActivityCounts };

// The project an agent works in: the project of the view it runs in, else the project whose folder holds its terminal
// (an agent in a view every project shows, like a pinned one, is told by its folder). null when neither says.
export function projectIdOfAgent(
    ws: { meta?: Record<string, any> },
    projects: WorkspaceProjectEntry[],
    info: AgentStateInfo,
    folder: string
): string {
    const owner = info.tabid ? tabProjectOf(ws, info.tabid) : "";
    if (owner !== "") {
        return owner;
    }
    return projectOfFolder(folder, projects)?.id ?? null;
}

// The agents of the workspace's other projects, counted by state; a project whose agents all idle is left out. Nothing
// for a workspace with fewer than two projects.
export function otherProjectsActivity(
    ws: { oid?: string; meta?: Record<string, any> },
    projects: WorkspaceProjectEntry[],
    agents: AgentStateInfo[],
    folderOf: (blockId: string) => string
): ProjectActivity[] {
    if (projects == null || projects.length < 2) {
        return [];
    }
    const current = currentProjectId(ws);
    const counts = new Map<string, ActivityCounts>();
    for (const info of agents ?? []) {
        if (info.workspaceid !== ws.oid || !(ActivityStates as readonly string[]).includes(info.state)) {
            continue;
        }
        const id = projectIdOfAgent(ws, projects, info, folderOf(info.blockid));
        if (id == null || id === current) {
            continue;
        }
        const own = counts.get(id) ?? {};
        own[info.state as ActivityState] = (own[info.state as ActivityState] ?? 0) + 1;
        counts.set(id, own);
    }
    return projects.filter((p) => counts.has(p.id)).map((p) => ({ project: p, counts: counts.get(p.id) }));
}

// "1 waiting for you · 2 working", the most urgent first.
export function activityText(counts: ActivityCounts): string {
    return ActivityStates.filter((s) => (counts[s] ?? 0) > 0)
        .map((s) => t("sidebar.project.activityItem", { count: counts[s], state: agentStateLabel(s) }))
        .join(" · ");
}

// The most urgent state of a project's agents: the colour its dot takes.
export function topActivityState(counts: ActivityCounts): ActivityState {
    return ActivityStates.find((s) => (counts[s] ?? 0) > 0) ?? null;
}
