// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import type { CardState } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import { AllProjects, ProjectPrRow, projectLanes, projectOfDir, resolveProjectFilter } from "./reviews-projects-model";

const Projects: WorkspaceProjectEntry[] = [
    { id: "p1", type: "Desktop", dir: "/p/desk", branch: "main" },
    { id: "p2", type: "Mobile", dir: "/p/mob", branch: "" },
    { id: "p3", type: "Website", dir: "", branch: "" },
];

function row(projectId: string, number: number, turn: CardState["turn"]): ProjectPrRow {
    return {
        projectId,
        dir: `/${projectId}`,
        pr: { number, title: `PR ${number}` } as ReviewPr,
        card: { turn } as CardState,
    };
}

describe("Pilotage across projects (FR-SHELL-087)", () => {
    it("keeps a filter only while the workspace has its project", () => {
        expect(resolveProjectFilter(undefined, Projects)).toBe(AllProjects);
        expect(resolveProjectFilter("p2", Projects)).toBe("p2");
        expect(resolveProjectFilter("gone", Projects)).toBe(AllProjects);
    });

    it("finds the project a PR's folder belongs to, never one without a folder", () => {
        expect(projectOfDir(Projects, "/p/mob")?.id).toBe("p2");
        expect(projectOfDir(Projects, "")).toBeNull();
        expect(projectOfDir(Projects, "/elsewhere")).toBeNull();
    });

    it("merges every project's rows into the turn lanes, in project order", () => {
        const lanes = projectLanes(Projects, {
            p2: [row("p2", 7, "yours"), row("p2", 9, "waiting")],
            p1: [row("p1", 3, "agents"), row("p1", 4, "yours")],
        });
        expect(lanes.map((l) => l.turn)).toEqual(["yours", "agents", "waiting"]);
        expect(lanes[0].rows.map((r) => `${r.projectId}#${r.pr.number}`)).toEqual(["p1#4", "p2#7"]);
        expect(projectLanes(Projects, {})).toEqual([]);
    });
});
