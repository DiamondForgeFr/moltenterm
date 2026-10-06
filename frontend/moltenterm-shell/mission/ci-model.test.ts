// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { branchCi, branchMark, CiRunRecord, defaultCiJob, formatCiDuration, parseAnsi, upsertCiRun } from "./ci-model";

function run(id: string, startedat: number, extra: Partial<CiRunRecord> = {}): CiRunRecord {
    return { id, dir: "/p", sha: "abcdef0123", tree: "t", startedat, status: "success", jobs: [], ...extra };
}

describe("local CI model (FR-MC-011)", () => {
    it("keeps runs newest first, replacing an updated one", () => {
        const list = upsertCiRun([run("a", 1), run("b", 3)], run("a", 1, { status: "failure" }));
        expect(list.map((r) => [r.id, r.status])).toEqual([
            ["b", "success"],
            ["a", "failure"],
        ]);
    });

    it("opens a run on the job picked, else the failed, else the running, else the first", () => {
        const jobs = [
            { name: "check", status: "success" as const },
            { name: "e2e", status: "running" as const },
            { name: "rust", status: "failure" as const },
        ];
        expect(defaultCiJob(run("a", 1, { jobs }), "check")).toBe("check");
        expect(defaultCiJob(run("a", 1, { jobs }), "gone")).toBe("rust");
        expect(defaultCiJob(run("a", 1, { jobs: jobs.slice(0, 2) }), null)).toBe("e2e");
        expect(defaultCiJob(run("a", 1, { jobs: jobs.slice(0, 1) }), null)).toBe("check");
        expect(defaultCiJob(run("a", 1, { jobs, error: "worktree" }), null)).toBe("prepare");
    });

    it("marks branches and formats durations", () => {
        expect(branchMark("success")).toBe(" ✓");
        expect(branchMark("failure")).toBe(" ✗");
        expect(branchMark("missing")).toBe("");
        expect(formatCiDuration(42_000)).toBe("42s");
        expect(formatCiDuration(125_000)).toBe("2m 05s");
        expect(formatCiDuration(3_720_000)).toBe("1h 02m");
    });

    it("reads a branch's CI by the Now card's rule: running, else its commit's last run, else the verdict (#238)", () => {
        const branches = [
            { name: "develop", sha: "new", date: 0, verdict: "missing" as const },
            { name: "feature/1", sha: "abcdef0123", date: 0, verdict: "success" as const },
            { name: "feature/2", sha: "f2", date: 0, verdict: "failure" as const },
        ];
        const runs = [
            run("r3", 30, { branch: "feature/2", status: "queued" }),
            run("r2", 20, { branch: "feature/1", status: "failure" }),
            run("r1", 10, { branch: "develop", sha: "old", status: "success" }),
        ];
        const ci = { runs, branches };
        expect(branchCi(ci, "develop")).toMatchObject({ status: "missing", source: "none", last: { id: "r1" } });
        expect(branchCi(ci, "feature/1")).toMatchObject({ status: "failure", source: "run" });
        expect(branchCi(ci, "feature/2")).toMatchObject({ status: "failure", source: "verdict", last: null });
        expect(branchCi({ ...ci, running: "r1" }, "develop")).toMatchObject({ status: "running", source: "running" });
        expect(branchCi({ ...ci, running: "r1" }, "feature/1").running).toBeNull();
        expect(branchCi(null, "develop")).toMatchObject({ status: "missing", source: "none" });
        expect(branchMark(branchCi(ci, "develop").status)).toBe("");
        expect(branchMark(branchCi(ci, "feature/1").status)).toBe(" ✗");
    });

    it("colours a log from its SGR codes and drops other control sequences", () => {
        const segments = parseAnsi("ok \x1b[1;32mPASS\x1b[0m done\x1b[2K\r\n\x1b]0;title\x07\x1b[38;5;9mred\x1b[39m");
        expect(segments).toEqual([
            { text: "ok " },
            { text: "PASS", bold: true, color: "#4ade80" },
            { text: " done\r\n" },
            { text: "red", color: "#fca5a5" },
        ]);
        expect(parseAnsi("plain")).toEqual([{ text: "plain" }]);
    });
});
