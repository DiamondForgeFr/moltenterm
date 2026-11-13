// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar's agents grouped by project (FR-SHELL-084, #1867): when they belong to two projects or more, each project
// opens a group. The groups follow the workspace's own list of projects, never the focus or the agents' activity
// (#2296); the agents outside every project close the list. Pure, so the rules are tested without the app.

import type { AgentStateInfo } from "../agent-state-model";
import type { WorkspaceProjectEntry } from "./workspace-projects";

// project null: the agents outside every project.
export type AgentGroup = { project: WorkspaceProjectEntry | null; agents: AgentStateInfo[] };

// null when the agents belong to fewer than two projects: the list stays flat, with the project chips (#1746). Inside a
// group the agents keep the order they came in.
export function agentGroups(
    agents: AgentStateInfo[],
    projects: WorkspaceProjectEntry[],
    projectIdOf: (info: AgentStateInfo) => string
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
    const rtn: AgentGroup[] = known.map((project) => ({ project, agents: byId.get(project.id) }));
    if (outside.length > 0) {
        rtn.push({ project: null, agents: outside });
    }
    return rtn;
}
