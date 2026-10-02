// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeDeliveries } from "./cicd-panels";
import { formatAge, githubStateMessage, MissionGit, pipelineRequest, prsByBranch, toTreeData } from "./mission-model";

const git: MissionGit = {
    trunk: "develop",
    release: "main",
    branches: [{ name: "develop", sha: "d", date: "2026-10-01T00:00:00Z", commits: null, fork: null }],
    tags: [
        { name: "v1.0.0", sha: "a", date: "2026-09-01T00:00:00Z", notes: "First", notesinternal: "" },
        { name: "v1.1.0-1", sha: "b", date: "2026-09-20T00:00:00Z" },
    ],
    ahead: [],
    sincepublic: [],
};

describe("toTreeData", () => {
    it("keeps the project's branch names and reads the collector's tags", () => {
        const tree = toTreeData(git);
        expect(tree.trunk).toBe("develop");
        expect(tree.branches[0].commits).toEqual([]);
        expect(tree.tags[0]).toEqual({
            name: "v1.0.0",
            sha: "a",
            date: "2026-09-01T00:00:00Z",
            notes: "First",
            notesInternal: null,
        });
    });
});

describe("makeDeliveries", () => {
    it("joins tags and GitHub releases, newest first", () => {
        const rows = makeDeliveries(git, {
            state: "ok",
            workflows: [],
            releases: [
                {
                    tagName: "v1.0.0",
                    name: "1.0",
                    isDraft: false,
                    isPrerelease: false,
                    isLatest: true,
                    publishedAt: "2026-09-01T00:00:00Z",
                    createdAt: "",
                },
                {
                    tagName: "v1.2.0",
                    name: "draft",
                    isDraft: true,
                    isPrerelease: false,
                    isLatest: false,
                    publishedAt: "",
                    createdAt: "2026-09-30T00:00:00Z",
                },
            ],
        });
        expect(rows.map((r) => [r.tag, r.rc, r.github?.latest ?? null, r.github?.draft ?? null])).toEqual([
            ["v1.2.0", false, false, true],
            ["v1.1.0-1", true, null, null],
            ["v1.0.0", false, true, false],
        ]);
    });
});

describe("helpers", () => {
    it("explains why GitHub is empty", () => {
        expect(githubStateMessage({ state: "loggedout", workflows: [] })).toContain("gh auth login");
        expect(githubStateMessage({ state: "ok", workflows: [] })).toBeNull();
        expect(githubStateMessage(null)).toBeNull();
    });

    it("formats ages and maps pull requests by branch", () => {
        const now = Date.parse("2026-10-02T12:00:00Z");
        expect(formatAge(0, now)).toBe("never");
        expect(formatAge(now - 10_000, now)).toBe("just now");
        expect(formatAge(now - 5 * 60_000, now)).toBe("5 min ago");
        expect(prsByBranch([{ headRefName: "feature/31-x", number: 67, url: "u" } as any]).get("feature/31-x")).toEqual(
            { number: 67, url: "u" }
        );
    });

    it("writes the request for the user's agent with the project folder", () => {
        expect(pipelineRequest("/p/notulia")).toContain("/p/notulia");
        expect(pipelineRequest("/p/notulia")).toContain(".molten/project.json");
    });
});
