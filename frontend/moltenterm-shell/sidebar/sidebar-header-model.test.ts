// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectLogoMetaKey } from "../workspace-project";
import { headerIcon, workspaceHeaderLogo } from "./sidebar-header-model";

const ws = (meta: Record<string, unknown>) => ({ oid: "w1", meta }) as unknown as Workspace;

describe("the workspace title (#1278)", () => {
    it("shows the linked project's logo, and nothing without one", () => {
        expect(workspaceHeaderLogo(ws({ [ProjectLogoMetaKey]: "/p/logo.svg" }))).toBe("/p/logo.svg");
        expect(workspaceHeaderLogo(ws({}))).toBe("");
        expect(workspaceHeaderLogo(ws({ [ProjectLogoMetaKey]: "  " }))).toBe("");
        expect(workspaceHeaderLogo(null)).toBe("");
    });

    it("has no separator under the top row, and a title one step bigger", () => {
        const src = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
        const header = src.slice(
            src.indexOf('data-testid="sidebar-header"') - 200,
            src.indexOf('data-testid="sidebar-workspace-name"')
        );
        expect(header).not.toMatch(/border-t/);
        expect(header).toContain("text-12 font-semibold");
    });
});

describe("the header's icon follows the current project (#1760)", () => {
    const projects = (current: string, logoOfP2?: string) => ({
        "molten:projects": [
            { id: "p1", type: "Desktop", dir: "/x/Notulia" },
            { id: "p2", type: "Website", dir: "/x/Notulia-website", ...(logoOfP2 ? { logo: logoOfP2 } : {}) },
        ],
        "molten:currentproject": current,
        "molten:project": current === "p1" ? "/x/Notulia" : "/x/Notulia-website",
        "molten:projecttype": current === "p1" ? "Desktop" : "Website",
    });

    it("shows the logo the workspace keeps while it is inside the current project's folder", () => {
        const meta = { ...projects("p1"), [ProjectLogoMetaKey]: "/x/Notulia/logo.svg" };
        expect(headerIcon(ws(meta), [])).toEqual({ kind: "logo", logo: "/x/Notulia/logo.svg" });
        expect(headerIcon(ws({ ...meta, ...projects("p2") }), [])).toEqual({ kind: "workspace" });
    });

    it("takes the first image found in the project's folder, and its own chosen logo before it", () => {
        const found = ["/x/Notulia-website/icon.png", "/x/Notulia-website/logo.svg"];
        expect(headerIcon(ws(projects("p2")), found)).toEqual({ kind: "logo", logo: found[0] });
        const chosen = projects("p2", "/x/Notulia-website/logo.svg");
        expect(headerIcon(ws(chosen), found)).toEqual({ kind: "logo", logo: "/x/Notulia-website/logo.svg" });
    });

    it("ignores a logo that is not in the project's folder", () => {
        const outside = projects("p2", "/elsewhere/logo.svg");
        expect(headerIcon(ws(outside), [])).toEqual({ kind: "workspace" });
    });

    it("shows the workspace's icon for a project without a logo", () => {
        expect(headerIcon(ws(projects("p1")), [])).toEqual({ kind: "workspace" });
    });

    it("keeps a workspace with one project as it was: its logo, else nothing", () => {
        const one = { "molten:project": "/x/Notulia", [ProjectLogoMetaKey]: "/x/Notulia/logo.svg" };
        expect(headerIcon(ws(one), ["/x/Notulia/icon.png"])).toEqual({ kind: "logo", logo: "/x/Notulia/logo.svg" });
        expect(headerIcon(ws({ "molten:project": "/x/Notulia" }), ["/x/Notulia/icon.png"])).toEqual({ kind: "none" });
    });
});
