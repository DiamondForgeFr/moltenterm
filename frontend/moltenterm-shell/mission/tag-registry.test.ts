// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { GithubRelease, Milestone } from "./github";
import { MissionGit, MissionGithub, RunRecord } from "./mission-model";
import { tagRegistry } from "./tag-registry";

const git: MissionGit = {
    trunk: "develop",
    release: "main",
    branches: [],
    tags: [
        { name: "v1.0.0", sha: "a", date: "2026-09-01T00:00:00Z", notes: "# v1.0.0\n\nFirst release\n" },
        { name: "v1.1.0-1", sha: "b", date: "2026-09-20T00:00:00Z" },
    ],
    ahead: [],
    sincepublic: [],
};

const release = (tagName: string, extra: Partial<GithubRelease>): GithubRelease => ({
    tagName,
    name: tagName,
    isDraft: false,
    isPrerelease: false,
    isLatest: false,
    publishedAt: "",
    createdAt: "",
    ...extra,
});

const milestone = (title: string, extra: Partial<Milestone> = {}): Milestone => ({
    number: 1,
    title,
    open_issues: 2,
    closed_issues: 3,
    html_url: `https://github.com/o/r/milestone/${title}`,
    ...extra,
});

const build = (id: string, commit: string, state: RunRecord["state"], title = "Gold"): RunRecord => ({
    id,
    dir: "/p",
    kind: "build",
    stepid: "gold",
    title,
    command: "make gold",
    startedat: 0,
    state,
    phases: [],
    commit,
    logsize: 0,
});

describe("tagRegistry", () => {
    it("joins tags and GitHub releases, newest first", () => {
        const github: MissionGithub = {
            state: "ok",
            workflows: [],
            releases: [
                release("v1.0.0", { isLatest: true, publishedAt: "2026-09-01T00:00:00Z" }),
                release("v1.2.0", { isDraft: true, createdAt: "2026-09-30T00:00:00Z" }),
            ],
        };
        const rows = tagRegistry(git, github, []);
        expect(rows.map((r) => [r.tag, r.kind, r.github?.latest ?? null, r.github?.draft ?? null])).toEqual([
            ["v1.2.0", "public", false, true],
            ["v1.1.0-1", "rc", null, null],
            ["v1.0.0", "public", true, false],
        ]);
        expect(rows[2].notes).toBe("First release");
        expect(rows[1].version).toBe("1.1.0");
    });

    it("reads every tag from git without GitHub", () => {
        const rows = tagRegistry(git, { state: "nogh", workflows: [] }, null);
        expect(rows.map((r) => r.tag)).toEqual(["v1.1.0-1", "v1.0.0"]);
        expect(rows.every((r) => r.github == null && r.builds.length === 0)).toBe(true);
    });

    it("lists the versions planned in a milestone and not tagged yet, highest first (FR-MC-004)", () => {
        const github: MissionGithub = {
            state: "ok",
            workflows: [],
            milestones: [
                milestone("1.1.0"),
                milestone("v1.2.0", { due_on: "2026-11-01T00:00:00Z" }),
                milestone("Milestone 2.0.0"),
                milestone("Later"),
                milestone("v1"),
            ],
        };
        const rows = tagRegistry(git, github, []);
        expect(rows.map((r) => [r.tag, r.kind])).toEqual([
            ["v2.0.0", "planned"],
            ["v1.2.0", "planned"],
            ["v1.1.0-1", "rc"],
            ["v1.0.0", "public"],
        ]);
        expect(rows[1]).toMatchObject({
            date: "2026-11-01T00:00:00Z",
            milestone: { title: "v1.2.0", open: 2, closed: 3, url: "https://github.com/o/r/milestone/v1.2.0" },
        });
    });

    it("marks the tags a local build was made from, successful builds only", () => {
        const runs = [
            build("r3", "a", "success", "Gold"),
            build("r2", "a", "success", "Gold"),
            build("r1", "b", "failure"),
            build("r0", "a", "success", "Beta"),
        ];
        const rows = tagRegistry(git, null, runs);
        expect(rows.find((r) => r.tag === "v1.0.0").builds).toEqual(["Gold", "Beta"]);
        expect(rows.find((r) => r.tag === "v1.1.0-1").builds).toEqual([]);
    });

    it("orders tags made in the same second by version", () => {
        const at = "2026-10-06T12:23:38+02:00";
        const sameSecond: MissionGit = {
            ...git,
            tags: ["v1.0.0", "v1.1.0-2", "v1.1.0", "v1.1.0-10"].map((name) => ({ name, sha: name, date: at })),
        };
        expect(tagRegistry(sameSecond, null, []).map((r) => r.tag)).toEqual([
            "v1.1.0",
            "v1.1.0-10",
            "v1.1.0-2",
            "v1.0.0",
        ]);
    });

    it("reads the project's tag prefix", () => {
        const prefixed: MissionGit = {
            ...git,
            tagprefix: "release-",
            tags: [{ name: "release-1.0.0-2", sha: "c", date: "2026-09-01T00:00:00Z" }],
        };
        const rows = tagRegistry(prefixed, { state: "ok", workflows: [], milestones: [milestone("1.0.0")] }, []);
        expect(rows.map((r) => [r.tag, r.kind, r.version])).toEqual([["release-1.0.0-2", "rc", "1.0.0"]]);
    });
});
