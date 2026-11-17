// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { agentGroups } from "./sidebar-agents-group";
import type { WorkspaceProjectEntry } from "./workspace-projects";

const Desk: WorkspaceProjectEntry = { id: "p1", type: "desktop", dir: "/w/desk", branch: "" };
const Web: WorkspaceProjectEntry = { id: "p2", type: "website", dir: "/w/web", branch: "" };
const Api: WorkspaceProjectEntry = { id: "p3", type: "api", dir: "/w/api", branch: "" };
const Projects = [Desk, Web, Api];

function agent(blockid: string, since: number, started?: number): AgentStateInfo {
    return { blockid, workspaceid: "ws1", state: "idle", since, started, version: 1 };
}

// The project of each agent, by its block id; "" for an agent in no project.
function projectIdOf(map: Record<string, string>) {
    return (info: AgentStateInfo) => map[info.blockid] ?? "";
}

function names(groups: { project: WorkspaceProjectEntry | null; agents: AgentStateInfo[] }[]) {
    return groups.map((g) => [g.project?.id ?? "none", g.agents.map((a) => a.blockid)]);
}

describe("agent groups by project (FR-SHELL-084, #1867)", () => {
    it("stays flat when the agents belong to one project", () => {
        const agents = [agent("a", 10), agent("b", 20)];
        expect(agentGroups(agents, Projects, projectIdOf({ a: "p1", b: "p1" }))).toBeNull();
    });

    it("stays flat when one project's agents sit beside agents outside every project", () => {
        const agents = [agent("a", 10), agent("b", 20)];
        expect(agentGroups(agents, Projects, projectIdOf({ a: "p1" }))).toBeNull();
    });

    it("stays flat when there are no agents", () => {
        expect(agentGroups([], Projects, () => "")).toBeNull();
    });

    it("groups the agents by project and keeps their order inside a group", () => {
        const agents = [agent("a", 10), agent("b", 20), agent("c", 30), agent("d", 40)];
        const ids = projectIdOf({ a: "p2", b: "p1", c: "p2", d: "p1" });
        expect(names(agentGroups(agents, Projects, ids))).toEqual([
            ["p1", ["b", "d"]],
            ["p2", ["a", "c"]],
        ]);
    });

    it("keeps the workspace's project order whatever the agents' activity (#2296)", () => {
        const quiet = [agent("a", 10), agent("b", 20), agent("c", 30)];
        const busy = [agent("a", 10), agent("b", 20), agent("c", 999, 999)];
        const ids = projectIdOf({ a: "p1", b: "p2", c: "p3" });
        expect(names(agentGroups(quiet, Projects, ids)).map((g) => g[0])).toEqual(["p1", "p2", "p3"]);
        expect(names(agentGroups(busy, Projects, ids)).map((g) => g[0])).toEqual(["p1", "p2", "p3"]);
    });

    it("closes the list with the agents outside every project, even when they are the most recent", () => {
        const agents = [agent("a", 10), agent("b", 99), agent("c", 20)];
        const ids = projectIdOf({ a: "p1", c: "p2" });
        expect(names(agentGroups(agents, Projects, ids))).toEqual([
            ["p1", ["a"]],
            ["p2", ["c"]],
            ["none", ["b"]],
        ]);
    });

    it("treats an agent of an unknown project as outside every project", () => {
        const agents = [agent("a", 10), agent("b", 20), agent("c", 30)];
        const ids = projectIdOf({ a: "p1", b: "ghost", c: "p2" });
        expect(names(agentGroups(agents, Projects, ids))).toEqual([
            ["p1", ["a"]],
            ["p2", ["c"]],
            ["none", ["b"]],
        ]);
    });
});
