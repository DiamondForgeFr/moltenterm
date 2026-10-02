// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeDeliveries } from "./cicd-panels";
import {
    formatAge,
    formatElapsed,
    githubStateMessage,
    jobsByLane,
    latestRun,
    logTail,
    MissionGit,
    pipelineStage,
    prsByBranch,
    toTreeData,
    upsertRun,
} from "./mission-model";

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

    it("reads the pipeline's stage and groups jobs by lane", () => {
        expect(pipelineStage(null)).toBe("loading");
        expect(pipelineStage({ path: "p", present: false, valid: false, errors: [], warnings: [] })).toBe("absent");
        expect(pipelineStage({ path: "p", present: true, valid: false, errors: ["x"], warnings: [] })).toBe("invalid");
        const lanes = jobsByLane({
            schema: 1,
            name: "x",
            ci: {
                jobs: [
                    { name: "check", lane: "web", run: "a" },
                    { name: "rust", lane: "rust", run: "b" },
                    { name: "e2e", lane: "web", run: "c" },
                    { name: "lint", run: "d" },
                ],
            },
        });
        expect(lanes.map((l) => [l.lane, l.jobs.map((j) => j.name)])).toEqual([
            ["web", ["check", "e2e"]],
            ["rust", ["rust"]],
            ["main", ["lint"]],
        ]);
        expect(jobsByLane(null)).toEqual([]);
    });
});

describe("runs", () => {
    const run = (id: string, startedat: number, kind = "build") => ({ id, startedat, kind }) as any;

    it("keeps the runs newest first and replaces an updated one", () => {
        const runs = upsertRun([run("a", 1), run("b", 2)], { ...run("a", 1), state: "success" });
        expect(runs.map((r) => r.id)).toEqual(["b", "a"]);
        expect(runs[1].state).toBe("success");
        expect(latestRun([run("c", 3, "ci"), run("b", 2)], "build").id).toBe("b");
        expect(latestRun([], "build")).toBeNull();
    });

    it("shows the last lines of a log without colours or the exit marker", () => {
        expect(logTail("\x1b[32mok\x1b[0m\n\nstep 2\r\nexit=0\n", 5)).toEqual(["ok", "step 2"]);
        expect(logTail("a\nb\nc", 2)).toEqual(["b", "c"]);
    });

    it("formats elapsed times", () => {
        expect(formatElapsed(42_000)).toBe("42 s");
        expect(formatElapsed(125_000)).toBe("2 min 05");
        expect(formatElapsed(3_725_000)).toBe("1 h 02");
    });
});
