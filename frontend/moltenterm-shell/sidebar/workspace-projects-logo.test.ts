// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { listValue, ProjectsMetaKey, readProjects } from "./workspace-projects";
import { editProjectUpdate } from "./workspace-projects-edit";

const ws = {
    meta: {
        [ProjectsMetaKey]: [
            { id: "p1", type: "Desktop", dir: "/x/a" },
            { id: "p2", type: "Website", dir: "/x/b", logo: "/x/b/logo.svg" },
        ],
        "molten:currentproject": "p1",
        "molten:project": "/x/a",
        "molten:projecttype": "Desktop",
    },
};

describe("a project's chosen logo (#1760)", () => {
    it("is read from the list and written back with it", () => {
        const projects = readProjects(ws);
        expect(projects[1].logo).toBe("/x/b/logo.svg");
        expect(projects[0].logo).toBeUndefined();
        expect(listValue(projects)[1]).toEqual({ id: "p2", type: "Website", dir: "/x/b", logo: "/x/b/logo.svg" });
        expect(listValue(projects)[0]).toEqual({ id: "p1", type: "Desktop", dir: "/x/a" });
    });

    it("stays with the project when it is edited without moving its folder, and goes when the folder changes", () => {
        const kept = editProjectUpdate(ws, "p2", { type: "Site", dir: "/x/b", branch: "main" });
        expect((kept[ProjectsMetaKey] as any[])[1].logo).toBe("/x/b/logo.svg");
        const moved = editProjectUpdate(ws, "p2", { type: "Site", dir: "/x/c", branch: "" });
        expect((moved[ProjectsMetaKey] as any[])[1].logo).toBeUndefined();
    });
});
