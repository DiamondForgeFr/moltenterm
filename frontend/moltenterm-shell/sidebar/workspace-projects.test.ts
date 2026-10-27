// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    currentProject,
    projectChipLabel,
    projectLabel,
    readProjects,
    switchProjectUpdate,
} from "./workspace-projects";
import {
    addProjectUpdate,
    editProjectUpdate,
    projectDraftProblem,
    removeProjectUpdate,
} from "./workspace-projects-edit";

function apply(meta: Record<string, any>, update: Record<string, any>): { meta: Record<string, any> } {
    const next = { ...meta };
    for (const [key, value] of Object.entries(update)) {
        if (value == null) {
            delete next[key];
        } else {
            next[key] = value;
        }
    }
    return { meta: next };
}

const Notulia = {
    meta: {
        "molten:project": "/p/notulia",
        "molten:projecttype": "Desktop",
        "molten:currentproject": "p1",
        "molten:projects": [
            { id: "p1", type: "Desktop", dir: "/p/notulia", branch: "main" },
            { id: "p2", type: "Mobile", dir: "/p/notulia-mobile", branch: "develop" },
            { id: "p3", type: "Website", dir: "/p/notulia-site" },
        ],
    },
};

describe("workspace projects (FR-SHELL-087)", () => {
    it("reads a workspace without a list as one project made of its link and type", () => {
        expect(readProjects({ meta: {} })).toEqual([]);
        expect(readProjects({ meta: { "molten:project": "/p/shop", "molten:projecttype": "SaaS" } })).toEqual([
            { id: "p1", type: "SaaS", dir: "/p/shop", branch: "" },
        ]);
        expect(readProjects({ meta: { "molten:projecttype": "CLI" } })).toHaveLength(1);
    });

    it("takes the current project's folder and type from the live keys", () => {
        const ws = { meta: { ...Notulia.meta, "molten:project": "/p/relinked", "molten:projecttype": "SaaS" } };
        expect(readProjects(ws)[0]).toEqual({ id: "p1", type: "SaaS", dir: "/p/relinked", branch: "main" });
        expect(currentProject(ws).id).toBe("p1");
    });

    it("falls back to the first project when the stored current one is gone, and skips broken entries", () => {
        const ws = {
            meta: {
                "molten:currentproject": "gone",
                "molten:projects": [{ type: "x" }, { id: "a", type: "API" }, { id: "a", type: "dup" }],
            },
        };
        expect(readProjects(ws).map((p) => p.id)).toEqual(["a"]);
        expect(currentProject(ws).id).toBe("a");
    });

    it("names a project by its type, else its folder, with its branch on the chip", () => {
        expect(projectLabel({ id: "p", type: "Mobile", dir: "/p/x", branch: "" })).toBe("Mobile");
        expect(projectLabel({ id: "p", type: "", dir: "/p/notulia-site", branch: "" })).toBe("notulia-site");
        expect(projectChipLabel({ id: "p", type: "Desktop", dir: "", branch: "main" })).toBe("Desktop · main");
    });

    it("switches: the target goes to the live keys and the folder new agents start in", () => {
        const update = switchProjectUpdate(Notulia, "p2");
        expect(update["molten:currentproject"]).toBe("p2");
        expect(update["molten:project"]).toBe("/p/notulia-mobile");
        expect(update["molten:projecttype"]).toBe("Mobile");
        expect(update["molten:folder"]).toBe("/p/notulia-mobile");
        const after = apply(Notulia.meta, update);
        expect(currentProject(after)).toEqual({
            id: "p2",
            type: "Mobile",
            dir: "/p/notulia-mobile",
            branch: "develop",
        });
        expect(readProjects(after)[0]).toEqual({ id: "p1", type: "Desktop", dir: "/p/notulia", branch: "main" });
        expect(switchProjectUpdate(after, "p2")).toBeNull();
        expect(switchProjectUpdate(after, "nope")).toBeNull();
    });

    it("keeps a relinked current project when switching away", () => {
        const ws = { meta: { ...Notulia.meta, "molten:project": "/p/relinked" } };
        const after = apply(ws.meta, switchProjectUpdate(ws, "p3"));
        expect(readProjects(after)[0].dir).toBe("/p/relinked");
    });

    it("adds a project: the first becomes current, a later one waits", () => {
        const first = addProjectUpdate({ meta: {} }, { type: "CLI", dir: "/p/cli", branch: "main" });
        expect(first.update["molten:project"]).toBe("/p/cli");
        expect(first.update["molten:projecttype"]).toBe("CLI");
        const more = addProjectUpdate(Notulia, { type: " API ", dir: "/p/api", branch: "" });
        expect(more.id).toBe("p4");
        expect(more.update["molten:project"]).toBeUndefined();
        const after = apply(Notulia.meta, more.update);
        expect(readProjects(after).map((p) => p.type)).toEqual(["Desktop", "Mobile", "Website", "API"]);
        expect(currentProject(after).id).toBe("p1");
    });

    it("refuses a draft without type or folder, or with a folder the workspace already has", () => {
        expect(projectDraftProblem(Notulia, { type: "", dir: "", branch: "" })).toBe(
            "sidebar.project.needTypeOrFolder"
        );
        expect(projectDraftProblem(Notulia, { type: "X", dir: "/p/notulia-mobile/", branch: "" })).toBe(
            "sidebar.project.folderTaken"
        );
        expect(projectDraftProblem(Notulia, { type: "Mobile", dir: "/p/notulia-mobile", branch: "" }, "p2")).toBeNull();
        expect(projectDraftProblem(Notulia, { type: "x".repeat(41), dir: "", branch: "" })).toBe(
            "sidebar.project.typeTooLong"
        );
    });

    it("edits a project; the current one's type and folder go live", () => {
        const other = editProjectUpdate(Notulia, "p3", { type: "Site", dir: "/p/notulia-site", branch: "main" });
        expect(other["molten:projecttype"]).toBeUndefined();
        expect(readProjects(apply(Notulia.meta, other))[2]).toEqual({
            id: "p3",
            type: "Site",
            dir: "/p/notulia-site",
            branch: "main",
        });
        const own = editProjectUpdate(Notulia, "p1", { type: "SaaS", dir: "/p/notulia", branch: "main" });
        expect(own["molten:projecttype"]).toBe("SaaS");
        expect(own["molten:folder"]).toBeUndefined();
        const moved = editProjectUpdate(Notulia, "p1", { type: "SaaS", dir: "/p/other", branch: "" });
        expect(moved["molten:project"]).toBe("/p/other");
    });

    it("removes a project from two on; the current one hands over to the first left", () => {
        expect(removeProjectUpdate({ meta: { "molten:project": "/p/x" } }, "p1")).toBeNull();
        const after = apply(Notulia.meta, removeProjectUpdate(Notulia, "p1"));
        expect(readProjects(after).map((p) => p.id)).toEqual(["p2", "p3"]);
        expect(currentProject(after).dir).toBe("/p/notulia-mobile");
        const other = removeProjectUpdate(Notulia, "p3");
        expect(other["molten:project"]).toBeUndefined();
    });
});
