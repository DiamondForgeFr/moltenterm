// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar's agents grouped by project (FR-SHELL-084, #1867): when they belong to two projects or more, each project
// opens a group. The active project's group comes first, then the groups by most recent agent activity; the agents
// outside every project close the list. Pure, so the rules are tested without the app.

import type { AgentStateInfo } from "../agent-state-model";
import { tabProjectOf } from "../hidden-tabs";
import { currentProjectId, type WorkspaceProjectEntry } from "./workspace-projects";

// project null: the agents outside every project.
export type AgentGroup = { project: WorkspaceProjectEntry | null; agents: AgentStateInfo[] };

// The project the sidebar takes as active: the one of the focused view, else the workspace's current project.
export function activeProjectOf(ws: { meta?: Record<string, any> }, activeTabId: string): string {
    return tabProjectOf(ws ?? {}, activeTabId) || currentProjectId(ws ?? {}) || "";
}

// null when the agents belong to fewer than two projects: the list stays flat, with the project chips (#1746). Inside a
// group the agents keep the order they came in.
export function agentGroups(
    agents: AgentStateInfo[],
    projects: WorkspaceProjectEntry[],
    projectIdOf: (info: AgentStateInfo) => string,
    activeProjectId: string
): AgentGroup[] {
    const listed = projects ?? [];
    const byId = new Map<string, AgentStateInfo[]>();
    const outside: AgentStateInfo[] = [];
    for (const info of agents ?? []) {
        const id = projectIdOf(info) || "";
        if (id === "" || !listed.some((p) => p.id === id)) {
            outside.push(info);
            continue;
        }
        byId.set(id, [...(byId.get(id) ?? []), info]);
    }
    const known = listed.filter((p) => byId.has(p.id));
    if (known.length < 2) {
        return null;
    }
    const groups = known.map((project, index) => ({
        project,
        agents: byId.get(project.id),
        index,
        recent: mostRecent(byId.get(project.id)),
    }));
    groups.sort(
        (a, b) =>
            Number(b.project.id === activeProjectId) - Number(a.project.id === activeProjectId) ||
            b.recent - a.recent ||
            a.index - b.index
    );
    const rtn: AgentGroup[] = groups.map(({ project, agents: list }) => ({ project, agents: list }));
    if (outside.length > 0) {
        rtn.push({ project: null, agents: outside });
    }
    return rtn;
}

// When a project's agents were last active (Unix ms): the latest of their state changes and run starts.
function mostRecent(agents: AgentStateInfo[]): number {
    return Math.max(0, ...agents.map((a) => Math.max(a.since ?? 0, a.started ?? 0)));
}
