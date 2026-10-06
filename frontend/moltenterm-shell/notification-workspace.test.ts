// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MissingWorkspaceName, workspaceLabel, workspaceLabelText } from "./notification-workspace";
import { ProjectLogoMetaKey, ProjectMetaKey } from "./workspace-project";

function ws(oid: string, name: string, dir = "", logo = ""): Workspace {
    return {
        oid,
        name,
        icon: "rocket",
        color: "#58C142",
        tabids: [],
        meta: { [ProjectMetaKey]: dir, [ProjectLogoMetaKey]: logo },
        otype: "workspace",
        version: 1,
    } as unknown as Workspace;
}

const Known = new Map([
    ["a", ws("a", "Notulia", "/work/notulia", "icon.svg")],
    ["b", ws("b", "Work", "/work/MoltenTerm")],
]);

describe("workspaceLabel", () => {
    it("labels an item of the current workspace like any other, flagged as current", () => {
        expect(workspaceLabel("a", Known, "a")).toMatchObject({
            name: "Notulia",
            project: "",
            icon: "rocket",
            color: "#58C142",
            logo: "icon.svg",
            current: true,
            missing: false,
        });
    });

    it("labels an item of another workspace", () => {
        const label = workspaceLabel("b", Known, "a");
        expect(label).toMatchObject({ id: "b", name: "Work", current: false, missing: false });
    });

    it("adds the project only when it differs from the workspace name", () => {
        expect(workspaceLabelText(workspaceLabel("b", Known, "a"))).toBe("Work · MoltenTerm");
        expect(workspaceLabelText(workspaceLabel("a", Known, "a"))).toBe("Notulia");
        const same = new Map([["c", ws("c", "moltenterm", "/work/MoltenTerm")]]);
        expect(workspaceLabel("c", same, "x").project).toBe("");
    });

    it("shows nothing for a global item", () => {
        expect(workspaceLabel(undefined, Known, "a")).toBeNull();
        expect(workspaceLabel("", Known, "a")).toBeNull();
    });

    it("keeps a label for a deleted workspace, leading nowhere", () => {
        expect(workspaceLabel("gone", Known, "a")).toMatchObject({
            id: "gone",
            name: MissingWorkspaceName,
            current: false,
            missing: true,
        });
    });
});
