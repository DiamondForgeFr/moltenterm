// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    describeCron,
    mergeStateLabel,
    nextRuns,
    parseCron,
    prSummary,
    releaseNotesText,
    runState,
    scheduledWorkflows,
    summarizeChecks,
} from "./github";

describe("checks", () => {
    it("summarizes a rollup, GitHub's checks before local ones, the latest winning", () => {
        const checks = summarizeChecks([
            { name: "local-check", context: "local-check", state: "SUCCESS" },
            { name: "Frontend", status: "IN_PROGRESS" },
            { name: "Backend", status: "COMPLETED", conclusion: "FAILURE" },
            { name: "Backend", status: "COMPLETED", conclusion: "SUCCESS" },
            { name: "Lint", status: "COMPLETED", conclusion: "SKIPPED" },
        ]);
        expect(checks.map((c) => [c.name, c.state, c.local])).toEqual([
            ["Backend", "success", false],
            ["Frontend", "pending", false],
            ["Lint", "neutral", false],
            ["local-check", "success", true],
        ]);
        expect(summarizeChecks(null)).toEqual([]);
    });

    // #797: the draft's run that skipped Backend comes after the ready run where it failed; the latest start wins.
    it("keeps the run that started last, per workflow", () => {
        const checks = summarizeChecks([
            {
                name: "Backend",
                workflowName: "CI",
                status: "COMPLETED",
                conclusion: "FAILURE",
                startedAt: "2026-10-16T15:07:05Z",
            },
            {
                name: "Backend",
                workflowName: "CI",
                status: "COMPLETED",
                conclusion: "SKIPPED",
                startedAt: "2026-10-16T15:06:25Z",
            },
            { name: "Backend", workflowName: "Nightly", status: "COMPLETED", conclusion: "SUCCESS" },
            {
                name: "Frontend",
                workflowName: "CI",
                status: "QUEUED",
                startedAt: "0001-01-01T00:00:00Z",
            },
            {
                name: "Frontend",
                workflowName: "CI",
                status: "COMPLETED",
                conclusion: "SUCCESS",
                startedAt: "2026-10-16T15:07:05Z",
            },
        ]);
        expect(checks.map((c) => [c.name, c.state])).toEqual([
            ["Backend", "failure"],
            ["Backend", "success"],
            ["Frontend", "pending"],
        ]);
    });

    it("labels merge states with the project's base branch", () => {
        expect(mergeStateLabel("DIRTY", "develop")).toEqual({ label: "conflicts with develop", tone: "failure" });
        expect(mergeStateLabel(null, "main").tone).toBe("pending");
    });

    it("reads a run's state", () => {
        expect(runState("completed", "success")).toBe("success");
        expect(runState("in_progress", null)).toBe("pending");
        expect(runState("completed", "cancelled")).toBe("failure");
    });
});

describe("scheduled workflows", () => {
    it("reads names and crons, skipping comments", () => {
        const files = [
            {
                name: "ci.yml",
                text: "name: CI\non:\n  schedule:\n    - cron: '17 2 * * *' # nightly\n    # - cron: '0 0 * * *'\n",
            },
            { name: "pr.yml", text: "name: PR\non: pull_request\n" },
        ];
        expect(scheduledWorkflows(files)).toEqual([{ file: "ci.yml", name: "CI", crons: ["17 2 * * *"] }]);
    });

    it("computes the next runs in UTC and says them in words", () => {
        const runs = nextRuns("0 3 * * 1-5", new Date("2026-10-02T12:00:00Z"), 2);
        expect(runs.map((d) => d.toISOString())).toEqual(["2026-10-05T03:00:00.000Z", "2026-10-06T03:00:00.000Z"]);
        expect(describeCron("17 2 * * *")).toBe("every day at 02:17 UTC");
        expect(describeCron("0 3 * * 1-5")).toBe("Monday to Friday at 03:00 UTC");
        expect(describeCron("0 6 * * 1")).toBe("every Monday at 06:00 UTC");
        expect(describeCron("*/15 * * * *")).toBe('cron "*/15 * * * *"');
        expect(parseCron("bad")).toBeNull();
    });
});

describe("prSummary", () => {
    it("takes the Summary section and drops the closing line otherwise", () => {
        expect(prSummary("## Summary\n\n- Adds **panels**\n\n## Tests\nall")).toBe("• Adds panels");
        expect(prSummary("Resolves #31\nShows the plan.")).toBe("Shows the plan.");
        expect(prSummary("")).toBeNull();
    });
});

describe("releaseNotesText", () => {
    it("leaves the front matter out", () => {
        const notes = "---\ndate: 2026-10-22\n---\n\n## What this version brings\n\nYou can **validate** a pull request.\n";
        expect(releaseNotesText(notes)).toBe("You can validate a pull request.");
    });

    it("reads notes without front matter as before", () => {
        expect(releaseNotesText("First line.\n\n- an item")).toBe("First line.\n\n• an item");
    });

    it("has nothing to show for a front matter alone", () => {
        expect(releaseNotesText("---\ndate: 2026-10-22\ndraft: true\n---\n")).toBe("");
        expect(releaseNotesText(null)).toBe("");
    });

    it("skips a heading that comes first, and keeps it when it is all the notes say", () => {
        expect(releaseNotesText("# v1.0.0-6\n\nThe first paragraph.")).toBe("The first paragraph.");
        expect(releaseNotesText("---\ndate: 2026-10-22\n---\n## Fixes for the **Versions** card")).toBe(
            "Fixes for the Versions card"
        );
    });
});
