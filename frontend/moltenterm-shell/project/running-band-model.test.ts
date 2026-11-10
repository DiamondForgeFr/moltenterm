// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { CiState } from "../mission/ci-model";
import { RunRecord } from "../mission/mission-model";
import { bandWork, workBandRow } from "./running-band-model";

const ci: CiState = {
    runs: [
        {
            id: "c1",
            dir: "/p",
            sha: "s",
            tree: "t",
            branch: "feature/2",
            startedat: 100,
            status: "running",
            jobs: [
                { name: "lint", status: "success" },
                { name: "test", status: "running" },
            ],
        },
    ],
    running: "c1",
    branches: [],
};

const runs = [
    { id: "b1", kind: "build", stepid: "gold", title: "Gold", state: "running", startedat: 50, phases: ["compile"] },
    { id: "s1", kind: "step", stepid: "deploy", title: "Deploy", state: "running", startedat: 60, phases: [] },
] as RunRecord[];

const session = { tag: "v1.2.0-rc.1", version: "1.2.0", channel: "rc" as const, startedat: 70 };

describe("what the band lists besides the build and the release followed (#2188)", () => {
    it("lists the CI run of a branch and the running steps", () => {
        const work = bandWork(ci, runs, null, { pipelined: true, trunk: "develop" });
        expect(work.map((w) => [w.kind, w.label])).toEqual([
            ["ci", "CI on feature/2"],
            ["step", "Deploy"],
        ]);
    });

    it("leaves the trunk's CI to its line in Now, and the builds to the build row", () => {
        const work = bandWork(ci, runs, null, { pipelined: true, trunk: "feature/2" });
        expect(work.map((w) => w.kind)).toEqual(["step"]);
    });

    it("lists the release as a plain run only when no pipeline follows it", () => {
        expect(bandWork(null, [], session, { pipelined: true, trunk: "develop" })).toEqual([]);
        expect(bandWork(null, [], session, { pipelined: false, trunk: "develop" }).map((w) => w.kind)).toEqual([
            "release",
        ]);
    });

    it("lists nothing when nothing runs", () => {
        expect(bandWork(null, [], null, { pipelined: true, trunk: "develop" })).toEqual([]);
    });
});

describe("workBandRow", () => {
    it("is a working row with its name, its detail and its start", () => {
        const [item] = bandWork(ci, [], null, { pipelined: true, trunk: "develop" });
        expect(workBandRow(item)).toMatchObject({
            kind: "work",
            tone: "working",
            name: "CI on feature/2",
            context: "1/2 jobs",
            startedat: 100,
            phases: [],
        });
    });
});
