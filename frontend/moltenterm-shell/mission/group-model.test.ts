// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    flaggedDependencies,
    groupMemberOf,
    isProductGroup,
    productGroupOfWorkspace,
    ProjectGroup,
} from "./group-model";

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

    it("flags the stale and the not committed dependencies only", () => {
        const dep = (state: any) => ({
            index: 0,
            project: "Notulia",
            paths: ["features/*.json"],
            output: ["src/features.json"],
            state,
        });
        const member = {
            ...notulia.members[1],
            state: { deps: [dep("insync"), dep("stale"), dep("uncommitted"), dep("sourcenotfound"), dep("error")] },
        };
        expect(flaggedDependencies(member).map((d) => d.state)).toEqual(["stale", "uncommitted"]);
        expect(flaggedDependencies(notulia.members[0])).toEqual([]);
        expect(flaggedDependencies(null)).toEqual([]);
    });
});
