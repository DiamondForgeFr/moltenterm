// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { MissingWorkspaceName, workspaceLabel, workspaceLabelText } from "./notification-workspace";
import { WorkspaceIconMetaKey } from "./workspace-icon-model";
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

    it("carries the imported icon, so the chip resolves it like the rail (FR-SHELL-031 AC8)", () => {
        const withImage = ws("d", "Client", "", "icon.svg");
        (withImage.meta as Record<string, any>)[WorkspaceIconMetaKey] = "d-0123456789ab.png";
        const label = workspaceLabel("d", new Map([["d", withImage]]), "x");
        expect(label).toMatchObject({ image: "d-0123456789ab.png", logo: "icon.svg", icon: "rocket" });
        expect(workspaceLabel("gone", Known, "a").image).toBe("");
    });

    it("names the project of the view a notification comes from (#1760)", () => {
        const product = ws("m", "Notulia", "/work/Notulia");
        const meta = product.meta as Record<string, any>;
        meta["molten:projects"] = [
            { id: "p1", type: "Desktop", dir: "/work/Notulia" },
            { id: "p2", type: "Website", dir: "/work/Notulia-website" },
        ];
        meta["molten:currentproject"] = "p1";
        meta["molten:projecttype"] = "Desktop";
        meta["molten:tabprojects"] = { onSite: "p2", onDesktop: "p1" };
        const known = new Map([["m", product]]);
        expect(workspaceLabel("m", known, "m", "onSite").project).toBe("Website");
        expect(workspaceLabelText(workspaceLabel("m", known, "m", "onSite"))).toBe("Notulia · Website");
        expect(workspaceLabel("m", known, "m", "onDesktop").project).toBe("Desktop");
        expect(workspaceLabel("m", known, "m", "shared").project).toBe("");
        expect(workspaceLabel("m", known, "m").project).toBe("");
    });
});
