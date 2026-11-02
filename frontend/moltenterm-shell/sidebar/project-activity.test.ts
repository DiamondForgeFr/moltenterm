// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { TabProjectsMetaKey } from "../hidden-tabs";
import { activityText, otherProjectsActivity, projectIdOfAgent, topActivityState } from "./project-activity";
import type { WorkspaceProjectEntry } from "./workspace-projects";

const Projects: WorkspaceProjectEntry[] = [
    { id: "p1", type: "Desktop", dir: "/x/Notulia", branch: "" },
    { id: "p2", type: "Website", dir: "/x/Notulia-website", branch: "" },
    { id: "p3", type: "Mobile", dir: "/x/Notulia-mobile", branch: "" },
];

const Ws = {
    oid: "w1",
    meta: {
        "molten:projects": Projects,
        "molten:currentproject": "p1",
        [TabProjectsMetaKey]: { tabA: "p1", tabB: "p2", tabC: "p3" },
    },
};

function agent(blockid: string, tabid: string, state: string, workspaceid = "w1"): AgentStateInfo {
    return { blockid, tabid, workspaceid, state, version: 1 } as AgentStateInfo;
}

const noFolder = () => "";

describe("projectIdOfAgent", () => {
    it("takes the project of the view the agent runs in", () => {
        expect(projectIdOfAgent(Ws, Projects, agent("b1", "tabB", "working"), "/x/Notulia")).toBe("p2");
    });

    it("tells an agent of a view every project shows by its folder", () => {
        expect(projectIdOfAgent(Ws, Projects, agent("b1", "pinned", "working"), "/x/Notulia-website/src")).toBe("p2");
        expect(projectIdOfAgent(Ws, Projects, agent("b1", "pinned", "working"), "/tmp")).toBeNull();
    });
});

describe("otherProjectsActivity", () => {
    it("counts the agents of the projects not shown, by state, in project order", () => {
        const agents = [
            agent("1", "tabB", "waiting"),
            agent("2", "tabB", "working"),
            agent("3", "tabB", "working"),
            agent("4", "tabC", "done"),
            agent("5", "tabA", "waiting"),
            agent("6", "tabC", "idle"),
        ];
        const got = otherProjectsActivity(Ws, Projects, agents, noFolder);
        expect(got.map((a) => a.project.id)).toEqual(["p2", "p3"]);
        expect(got[0].counts).toEqual({ waiting: 1, working: 2 });
        expect(got[1].counts).toEqual({ done: 1 });
    });

    it("leaves out the current project, another workspace's agents and a project that only idles", () => {
        const agents = [
            agent("1", "tabA", "error"),
            agent("2", "tabB", "waiting", "other"),
            agent("3", "tabC", "idle"),
        ];
        expect(otherProjectsActivity(Ws, Projects, agents, noFolder)).toEqual([]);
    });

    it("says nothing for a workspace with one project", () => {
        const one = { oid: "w1", meta: { "molten:projects": [Projects[0]] } };
        expect(otherProjectsActivity(one, [Projects[0]], [agent("1", "tabA", "waiting")], noFolder)).toEqual([]);
    });

    it("counts an agent of a pinned view in the project its folder is in", () => {
        const agents = [agent("1", "pinned", "waiting")];
        const got = otherProjectsActivity(Ws, Projects, agents, () => "/x/Notulia-mobile/app");
        expect(got).toEqual([{ project: Projects[2], counts: { waiting: 1 } }]);
    });
});

describe("activityText", () => {
    it("lists the most urgent state first", () => {
        expect(activityText({ working: 2, waiting: 1 })).toBe("1 waiting for you · 2 working");
        expect(activityText({ done: 1, error: 3 })).toBe("3 error · 1 done");
        expect(activityText({})).toBe("");
    });

    it("gives the dot the most urgent state's colour", () => {
        expect(topActivityState({ working: 2, waiting: 1 })).toBe("waiting");
        expect(topActivityState({ done: 1 })).toBe("done");
        expect(topActivityState({})).toBeNull();
    });
});
