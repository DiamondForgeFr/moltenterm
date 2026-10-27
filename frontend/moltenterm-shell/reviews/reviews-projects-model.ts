// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Pilotage across a workspace's projects (FR-SHELL-087): the filter chips (All projects, then each project) and the
// rows of every project's pull requests by whose turn it is, each tagged with its project.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import type { WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import type { CardState, CardTurn } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import { TurnOrder } from "./reviews-sections-model";

export const AllProjects = "all";

export type ProjectPrRow = { projectId: string; dir: string; pr: ReviewPr; card: CardState };

export type ProjectLane = { turn: CardTurn; rows: ProjectPrRow[] };

// The filter a workspace shows: a project it still has, else every project.
export function resolveProjectFilter(stored: string, projects: readonly WorkspaceProjectEntry[]): string {
    return stored != null && projects.some((p) => p.id === stored) ? stored : AllProjects;
}

// The project a PR another surface asked for belongs to, by its folder; null when none of the workspace's.
export function projectOfDir(projects: readonly WorkspaceProjectEntry[], dir: string): WorkspaceProjectEntry {
    if (!dir) {
        return null;
    }
    return projects.find((p) => p.dir !== "" && p.dir === dir) ?? null;
}

// Every project's rows merged into the turn lanes, in the workspace's project order, then by PR number within one
// project as each project's list gives them.
export function projectLanes(
    projects: readonly WorkspaceProjectEntry[],
    rowsByProject: Record<string, ProjectPrRow[]>
): ProjectLane[] {
    const lanes: ProjectLane[] = [];
    for (const turn of TurnOrder) {
        const rows: ProjectPrRow[] = [];
        for (const project of projects) {
            for (const row of rowsByProject[project.id] ?? []) {
                if (row.card?.turn === turn) {
                    rows.push(row);
                }
            }
        }
        if (rows.length > 0) {
            lanes.push({ turn, rows });
        }
    }
    return lanes;
}

// The filter each workspace's Pilotage shows, kept while the app runs.
export class ReviewsProjectFilter {
    private static instance: ReviewsProjectFilter = null;

    filtersAtom = atom({}) as PrimitiveAtom<Record<string, string>>;

    private constructor() {}

    static getInstance(): ReviewsProjectFilter {
        if (ReviewsProjectFilter.instance == null) {
            ReviewsProjectFilter.instance = new ReviewsProjectFilter();
        }
        return ReviewsProjectFilter.instance;
    }

    set(workspaceId: string, filter: string) {
        if (!workspaceId) {
            return;
        }
        const filters = globalStore.get(this.filtersAtom);
        if (filters[workspaceId] === filter) {
            return;
        }
        globalStore.set(this.filtersAtom, { ...filters, [workspaceId]: filter });
    }
}
