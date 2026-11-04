// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { activeProjectOf, agentGroups } from "./sidebar-agents-group";
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
        expect(agentGroups(agents, Projects, projectIdOf({ a: "p1", b: "p1" }), "p1")).toBeNull();
    });

    it("stays flat when one project's agents sit beside agents outside every project", () => {
        const agents = [agent("a", 10), agent("b", 20)];
        expect(agentGroups(agents, Projects, projectIdOf({ a: "p1" }), "p1")).toBeNull();
    });

    it("stays flat when there are no agents", () => {
        expect(agentGroups([], Projects, () => "", "p1")).toBeNull();
    });

    it("groups the agents by project and keeps their order inside a group", () => {
        const agents = [agent("a", 10), agent("b", 20), agent("c", 30), agent("d", 40)];
        const ids = projectIdOf({ a: "p2", b: "p1", c: "p2", d: "p1" });
        expect(names(agentGroups(agents, Projects, ids, "p3"))).toEqual([
            ["p1", ["b", "d"]],
            ["p2", ["a", "c"]],
        ]);
    });

    it("opens the active project's group first, whatever its activity", () => {
        const agents = [agent("a", 10), agent("b", 90)];
        const ids = projectIdOf({ a: "p1", b: "p2" });
        expect(names(agentGroups(agents, Projects, ids, "p1"))[0][0]).toBe("p1");
        expect(names(agentGroups(agents, Projects, ids, "p2"))[0][0]).toBe("p2");
    });

    it("orders the other groups by their most recent agent activity", () => {
        const agents = [agent("a", 10), agent("b", 50), agent("c", 30)];
        const ids = projectIdOf({ a: "p1", b: "p2", c: "p3" });
        expect(names(agentGroups(agents, Projects, ids, "p1")).map((g) => g[0])).toEqual(["p1", "p2", "p3"]);
    });

    it("counts a run's start as activity when it is later than the last state change", () => {
        const agents = [agent("a", 10, 80), agent("b", 50)];
        const ids = projectIdOf({ a: "p1", b: "p2" });
        expect(names(agentGroups(agents, Projects, ids, "p3")).map((g) => g[0])).toEqual(["p1", "p2"]);
    });

    it("keeps the workspace's project order when activity ties", () => {
        const agents = [agent("a", 10), agent("b", 10)];
        const ids = projectIdOf({ a: "p2", b: "p1" });
        expect(names(agentGroups(agents, Projects, ids, "p3")).map((g) => g[0])).toEqual(["p1", "p2"]);
    });

    it("closes the list with the agents outside every project, even when they are the most recent", () => {
        const agents = [agent("a", 10), agent("b", 99), agent("c", 20)];
        const ids = projectIdOf({ a: "p1", c: "p2" });
        expect(names(agentGroups(agents, Projects, ids, "p1"))).toEqual([
            ["p1", ["a"]],
            ["p2", ["c"]],
            ["none", ["b"]],
        ]);
    });

    it("treats an agent of an unknown project as outside every project", () => {
        const agents = [agent("a", 10), agent("b", 20), agent("c", 30)];
        const ids = projectIdOf({ a: "p1", b: "ghost", c: "p2" });
        expect(names(agentGroups(agents, Projects, ids, "p1"))).toEqual([
            ["p1", ["a"]],
            ["p2", ["c"]],
            ["none", ["b"]],
        ]);
    });
});

describe("the active project (#1867)", () => {
    const ws = {
        meta: {
            "molten:projects": [Desk, Web, Api],
            "molten:currentproject": "p2",
            "molten:tabprojects": { t1: "p3" },
        },
    };

    it("is the focused view's project", () => {
        expect(activeProjectOf(ws as any, "t1")).toBe("p3");
    });

    it("falls back to the workspace's current project when the view holds none", () => {
        expect(activeProjectOf(ws as any, "t9")).toBe("p2");
    });

    it("is empty without a workspace", () => {
        expect(activeProjectOf(undefined, "t1")).toBe("");
    });
});
