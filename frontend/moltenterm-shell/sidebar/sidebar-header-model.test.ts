// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectLogoMetaKey } from "../workspace-project";
import { workspaceHeaderLogo } from "./sidebar-header-model";

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
