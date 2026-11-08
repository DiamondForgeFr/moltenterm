// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import type { CardState } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import {
    AllProjects,
    projectLanes,
    projectOfDir,
    ProjectPrRow,
    resolveProjectFilter,
    ReviewsProjectFilter,
    ReviewsProjectMetaKey,
    storedProjectFilter,
} from "./reviews-projects-model";

// The workspaces as wavesrv holds them: a meta write lands there and reaches every page.
const backend = vi.hoisted(() => ({ meta: {} as Record<string, Record<string, unknown>> }));

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_client: unknown, data: { oref: string; meta: Record<string, unknown> }) => {
            backend.meta[data.oref] = { ...backend.meta[data.oref], ...data.meta };
        },
    },
}));

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

    it("finds a project by its repository first, then by its folder (#1777)", () => {
        const client = [
            { id: "a", type: "Web", dir: "/c/ofpis", branch: "", repo: "/c/ofpis/app" },
            { id: "b", type: "API", dir: "/c/ofpis", branch: "", repo: "/c/ofpis/api" },
            { id: "c", type: "Docs", dir: "/c/ofpis", branch: "" },
        ];
        expect(projectOfDir(client, "/c/ofpis/api")?.id).toBe("b");
        expect(projectOfDir(client, "/c/ofpis/app")?.id).toBe("a");
        expect(projectOfDir(client, "/c/ofpis")?.id).toBe("c");
        expect(projectOfDir(client.slice(0, 2), "/c/ofpis")?.id).toBe("a");
    });

    it("merges every project's rows into the turn lanes, in project order", () => {
        const lanes = projectLanes(Projects, {
            p2: [row("p2", 7, "yours"), row("p2", 9, "waiting")],
            p1: [row("p1", 3, "agents"), row("p1", 4, "yours")],
        });
        expect(lanes.map((l) => l.turn)).toEqual(["yours", "waiting", "agents"]);
        expect(lanes[0].rows.map((r) => `${r.projectId}#${r.pr.number}`)).toEqual(["p1#4", "p2#7"]);
        expect(projectLanes(Projects, {})).toEqual([]);
    });
});

describe("the project chip, saved on the workspace (#1758)", () => {
    const ws = (meta: Record<string, unknown> = {}) => ({ oid: "w1", meta }) as unknown as Workspace;

    it("reads the developer's choice from the workspace, which every view of it shares", () => {
        expect(storedProjectFilter({}, ws({ [ReviewsProjectMetaKey]: "p2" }))).toBe("p2");
        expect(storedProjectFilter({}, ws())).toBeNull();
        // A page that moved by itself (a PR asked for elsewhere) shows that project, the saved choice unchanged.
        expect(storedProjectFilter({ w1: "p1" }, ws({ [ReviewsProjectMetaKey]: "p2" }))).toBe("p1");
    });

    it("saves a chosen chip on the workspace, then follows the workspace again", async () => {
        const filter = ReviewsProjectFilter.getInstance();
        filter.choose("w1", "p2");
        expect(globalStore.get(filter.filtersAtom).w1).toBe("p2");
        await vi.waitFor(() => expect(backend.meta["workspace:w1"]?.[ReviewsProjectMetaKey]).toBe("p2"));
        await vi.waitFor(() => expect(globalStore.get(filter.filtersAtom).w1).toBeUndefined());
        // A new page knows only the workspace.
        expect(storedProjectFilter({}, ws(backend.meta["workspace:w1"]))).toBe("p2");
    });
});
