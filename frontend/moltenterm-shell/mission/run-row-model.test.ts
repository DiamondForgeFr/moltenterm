// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { RunRecord } from "./mission-model";
import { ReleaseFacts, releaseRun } from "./release-run";
import {
    buildBandRow,
    buildContext,
    durationText,
    estimateMs,
    phaseDurations,
    phaseShare,
    releaseBandRow,
} from "./run-row-model";

function run(extra: Partial<RunRecord> = {}): RunRecord {
    return {
        id: "r1",
        dir: "/p",
        kind: "build",
        stepid: "gold",
        title: "Gold",
        command: "task gold",
        startedat: 1_000_000,
        state: "running",
        phases: ["prepare", "frontend", "wavesrv"],
        logsize: 0,
        ...extra,
    };
}

const Defs = [
    { id: "prepare", title: "Prepare" },
    { id: "frontend", title: "Frontend" },
    { id: "wavesrv", title: "Wavesrv" },
    { id: "package", title: "Package" },
    { id: "install", title: "Install" },
];

describe("estimateMs", () => {
    const done = (id: string, startedat: number, finishedat: number, extra: Partial<RunRecord> = {}) =>
        run({ id, startedat, finishedat, state: "success", ...extra });

    it("is what the previous successful run of the same step took, newest first", () => {
        const runs = [run(), done("r0", 100, 400_100), done("rold", 10, 110)];
        expect(estimateMs(runs, run())).toBe(400_000);
    });

    it("ignores other steps, failures, the run itself and runs with no end", () => {
        const runs = [
            run(),
            done("rx", 100, 900, { stepid: "rc" }),
            done("rk", 100, 900, { kind: "release" }),
            run({ id: "rf", state: "failure", startedat: 100, finishedat: 900 }),
            done("rn", 100, undefined),
        ];
        expect(estimateMs(runs, run())).toBe(0);
        expect(estimateMs([], run())).toBe(0);
    });
});

// A build that took 300 s: prepare 20 s, frontend 100 s, wavesrv 100 s, package 60 s, install 20 s.
const Earlier = run({
    id: "r0",
    state: "success",
    startedat: 0,
    finishedat: 300_000,
    phases: ["prepare", "frontend", "wavesrv", "package", "install"],
    phaseat: [0, 20_000, 120_000, 220_000, 280_000],
});

describe("phaseDurations", () => {
    it("is how long each phase took, until the next marker or the end of the run", () => {
        expect(phaseDurations(Earlier)).toEqual({
            prepare: 20_000,
            frontend: 100_000,
            wavesrv: 100_000,
            package: 60_000,
            install: 20_000,
        });
    });

    it("is empty for a run recorded before the markers were stamped, and for none", () => {
        expect(phaseDurations({ ...Earlier, phaseat: undefined })).toEqual({});
        expect(phaseDurations(null)).toEqual({});
        expect(phaseDurations(run())).toEqual({});
    });

    it("keeps the first marker of a phase printed twice", () => {
        const twice = { ...Earlier, phases: ["prepare", "frontend", "frontend"], phaseat: [0, 20_000, 70_000] };
        expect(phaseDurations(twice).frontend).toBe(50_000);
    });
});

describe("phaseShare", () => {
    const current = run({
        startedat: 1_000_000,
        phases: ["prepare", "frontend", "wavesrv"],
        phaseat: [1_000_000, 1_020_000, 1_120_000],
    });

    it("is how far into the phase it is, from how long the same phase took the time before", () => {
        expect(phaseShare(current, Earlier, "wavesrv", 1_120_000 + 62_000)).toBeCloseTo(0.62, 5);
    });

    it("never reaches 0 or 100 while the phase runs", () => {
        expect(phaseShare(current, Earlier, "wavesrv", 1_120_000)).toBe(0.02);
        expect(phaseShare(current, Earlier, "wavesrv", 1_120_000 + 900_000)).toBe(0.98);
    });

    it("says nothing without an earlier build, a phase it did not have, or a stamp", () => {
        expect(phaseShare(current, null, "wavesrv", 1_200_000)).toBeNull();
        expect(phaseShare(current, { ...Earlier, phases: ["prepare"], phaseat: [0] }, "wavesrv", 1_200_000)).toBeNull();
        expect(phaseShare({ ...current, phaseat: undefined }, Earlier, "wavesrv", 1_200_000)).toBeNull();
        expect(phaseShare(current, Earlier, "package", 1_200_000)).toBeNull();
    });
});

describe("buildBandRow", () => {
    const now = 1_000_000 + 3 * 60_000 + 12_000;
    const started = run({ phaseat: [1_000_000, 1_020_000, 1_120_000] });

    it("names the run, its place and its phases, with the current one's progress from the last build's time", () => {
        const runs = [started, Earlier];
        const row = buildBandRow(started, Defs, null, runs, "develop", 1_120_000 + 62_000);
        expect(row).toMatchObject({ kind: "build", tone: "working", name: "Gold", estimateMs: 300_000 });
        expect(row.context).toBe("local build · develop");
        expect(row.phases.map((p) => [p.label, p.status])).toEqual([
            ["Prepare", "done"],
            ["Frontend", "done"],
            ["Wavesrv", "running"],
            ["Package", "todo"],
            ["Install", "todo"],
        ]);
        const current = row.phases.find((p) => p.current);
        expect(current).toMatchObject({ label: "Wavesrv", progress: "62%" });
        expect(current.fill).toBeCloseTo(0.62, 5);
        expect(row.phases.filter((p) => p.status === "done").every((p) => p.fill === 1)).toBe(true);
        expect(row.phases.filter((p) => p.status === "todo").every((p) => p.fill === 0)).toBe(true);
    });

    it("shows no percentage without an earlier build to measure against", () => {
        const row = buildBandRow(started, Defs, null, [started], "develop", now);
        const current = row.phases.find((p) => p.current);
        expect(current.progress).toBe("");
        expect(current.fill).toBeGreaterThan(0);
        expect(row.estimateMs).toBe(0);
    });

    it("keeps a failed build in the failure tone with why it stopped, on the phase it stopped in", () => {
        const row = buildBandRow(
            run({ state: "failure", finishedat: 1_000_000 + 5_000 }),
            Defs,
            null,
            [],
            "develop",
            now
        );
        expect(row.tone).toBe("failed");
        expect(row.endedat).toBe(1_005_000);
        expect(buildBandRow(run(), Defs, null, [], "develop", now).endedat).toBe(0);
        expect(row.note).toContain("Failed during");
        expect(row.note).toContain("Wavesrv");
        const current = row.phases.find((p) => p.current);
        expect(current).toMatchObject({ label: "Wavesrv", status: "failed", fill: 1 });
    });

    it("keeps how the commit was verified under the phase's text, whichever phase the build is in (#2277)", () => {
        expect(buildBandRow(run(), Defs, null, [], "develop", now).verification).toBe("");
        const verified = run({
            verify: { by: "github", runid: 123456, jobs: 6, sha: "69c7639", url: "https://x/run" },
        });
        const row = buildBandRow(verified, Defs, null, [], "develop", now);
        expect(row.verification).toBe("Verified by GitHub CI · run 123456 · 6 jobs green on 69c7639");
        expect(row.phases.find((p) => p.current).label).toBe("Wavesrv");
    });

    it("names the commit it builds", () => {
        expect(buildContext("develop", "9b79731abcdef")).toBe("local build · develop @ 9b79731");
        expect(buildContext("", "9b79731")).toBe("local build");
        expect(buildBandRow(run({ commit: "9b79731abcdef" }), Defs, null, [], "develop", now).context).toBe(
            "local build · develop @ 9b79731"
        );
    });
});

describe("releaseBandRow", () => {
    const base: ReleaseFacts = {
        tag: "v1.0.0-12",
        version: "1.0.0-12",
        channel: "rc",
        tagexists: true,
        steps: {},
        runs: [
            {
                databaseId: 1,
                workflowName: "release",
                headBranch: "v1.0.0-12",
                status: "in_progress",
                conclusion: "",
                url: "https://example.test/run/1",
                createdAt: "2026-11-10T10:00:00Z",
            },
        ],
        jobs: [
            { name: "a", status: "completed", conclusion: "success", startedAt: "", completedAt: "", url: "" },
            { name: "b", status: "in_progress", conclusion: "", startedAt: "", completedAt: "", url: "" },
            { name: "c", status: "queued", conclusion: "", startedAt: "", completedAt: "", url: "" },
            { name: "d", status: "queued", conclusion: "", startedAt: "", completedAt: "", url: "" },
        ],
        ontrunk: false,
    };

    it("shows the five phases, the current one named with the jobs done", () => {
        const rr = releaseRun(base, []);
        const row = releaseBandRow(rr, base.jobs, 5);
        expect(row).toMatchObject({ kind: "release", tone: "working", name: "Release v1.0.0-12", startedat: 5 });
        expect(row.context).toBe("release candidate · tag pushed");
        expect(row.phases.map((p) => p.label)).toEqual(["Prepare", "Cut", "Build", "Publish", "Back"]);
        const current = row.phases.find((p) => p.current);
        expect(current).toMatchObject({ label: "Build", status: "running", progress: "1/4", fill: 0.25 });
        expect(row.phases.find((p) => p.label === "Cut")).toMatchObject({ status: "done", fill: 1 });
    });

    it("is in the waiting tone while the current phase waits for the developer", () => {
        const waiting = releaseRun({ ...base, tagexists: false, runs: [], jobs: [] }, []);
        const row = releaseBandRow(waiting, [], 0);
        expect(row.tone).toBe("waiting");
        expect(row.phases.find((p) => p.current).progress).toBe("your turn");
        expect(row.context).toBe("release candidate");
    });

    it("is in the failure tone when a phase failed", () => {
        const failed = releaseRun(
            {
                ...base,
                runs: [{ ...base.runs[0], status: "completed", conclusion: "failure" }],
                jobs: [{ ...base.jobs[0], conclusion: "failure" }],
            },
            []
        );
        const row = releaseBandRow(failed, failed ? base.jobs : [], 0);
        expect(row.tone).toBe("failed");
        expect(row.phases.find((p) => p.current)).toMatchObject({ status: "failed", progress: "failed" });
    });
});

describe("durationText", () => {
    it("reads seconds, minutes with seconds under ten minutes, minutes, then hours", () => {
        expect(durationText(45_000)).toBe("45 s");
        expect(durationText(3 * 60_000 + 12_000)).toBe("3 min 12");
        expect(durationText(3 * 60_000 + 2_000)).toBe("3 min 02");
        expect(durationText(18 * 60_000 + 40_000)).toBe("18 min");
        expect(durationText(75 * 60_000)).toBe("1 h 15");
        expect(durationText(-5)).toBe("0 s");
    });
});
