// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { groupMemberOf, isProductGroup, productGroupOfWorkspace, ProjectGroup } from "./group-model";

const notulia: ProjectGroup = {
    key: "notulia",
    name: "Notulia",
    members: [
        { dir: "/p/app", name: "Notulia", group: "Notulia", workspaces: [{ id: "w-app" }], state: {} },
        { dir: "/p/site", name: "notulia-website", group: "notulia", workspaces: [{ id: "w-site" }], state: {} },
    ],
};

const alone: ProjectGroup = {
    key: "other",
    name: "Other",
    members: [{ dir: "/p/other", name: "Other", group: "Other", workspaces: [{ id: "w-other" }], state: {} }],
};

describe("project groups", () => {
    it("shows a product only from two linked members", () => {
        expect(isProductGroup(notulia)).toBe(true);
        expect(isProductGroup(alone)).toBe(false);
        expect(isProductGroup(null)).toBe(false);
    });

    it("finds the product of a workspace", () => {
        expect(productGroupOfWorkspace([alone, notulia], "w-site")).toBe(notulia);
        expect(productGroupOfWorkspace([alone, notulia], "w-other")).toBeNull();
        expect(productGroupOfWorkspace([notulia], "w-molten")).toBeNull();
        expect(productGroupOfWorkspace([notulia], "")).toBeNull();
    });

    it("finds a member by its folder", () => {
        expect(groupMemberOf(notulia, "/p/site")?.name).toBe("notulia-website");
        expect(groupMemberOf(notulia, "/p/molten")).toBeNull();
        expect(groupMemberOf(null, "/p/site")).toBeNull();
    });
});
