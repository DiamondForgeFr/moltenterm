// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PipelineReleaseStep } from "./mission-model";
import { ReleaseFacts, ReleaseGhRun, releaseRun, ReleaseTagWorkflow } from "./release-run";

// #1040: a release whose tag starts no workflow, or whose workflow never started, no longer waits forever.

const steps: PipelineReleaseStep[] = [{ id: "cut", title: "Cut", phase: "cut", run: "x" }];

const buildStep: PipelineReleaseStep[] = [...steps, { id: "pack", title: "Pack", phase: "build", run: "x" }];

const ok = { runid: "r", state: "success", running: false, exit: 0, tail: [], phases: [] };

function facts(extra: Partial<ReleaseFacts> = {}): ReleaseFacts {
    return {
        tag: "v1.2.0-1",
        version: "1.2.0",
        channel: "rc",
        tagexists: true,
        trunk: "develop",
        steps: { cut: ok, pack: ok },
        runs: [],
        jobs: [],
        ontrunk: true,
        ...extra,
    };
}

const wf = (extra: Partial<ReleaseTagWorkflow> = {}): ReleaseTagWorkflow => ({
    file: "release.yml",
    name: "Release",
    dispatch: false,
    publishes: true,
    ...extra,
});

const run = (extra: Partial<ReleaseGhRun> = {}): ReleaseGhRun => ({
    databaseId: 7,
    workflowName: "CI",
    headBranch: "v1.2.0-1",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/o/r/actions/runs/7",
    createdAt: "2026-10-24T10:00:00Z",
    ...extra,
});

describe("release run without a workflow on the tag (#1040)", () => {
    it("completes with nothing to build and nothing to publish when no workflow starts on the tag", () => {
        const r = releaseRun(facts({ tagworkflows: { workflows: [], overdue: false } }), steps);
        expect(r.phases[2]).toMatchObject({ status: "done", expect: expect.stringContaining("Nothing to build") });
        expect(r.phases[3]).toMatchObject({
            status: "done",
            expect: "Nothing to publish for this tag: no workflow starts on v1.2.0-1.",
        });
        expect(r.active).toBe(false);
    });

    it("says nothing to publish after the project's own build steps when no workflow starts on the tag", () => {
        const r = releaseRun(facts({ tagworkflows: { workflows: [], overdue: false } }), buildStep);
        expect(r.phases[3]).toMatchObject({ status: "done", expect: expect.stringContaining("Nothing to publish") });
    });

    it("still waits while the workflows are unknown, or while their run may still start", () => {
        expect(releaseRun(facts(), steps).phases[2].status).toBe("running");
        const young = releaseRun(facts({ tagworkflows: { workflows: [wf()], overdue: false } }), steps);
        expect(young.phases[2]).toMatchObject({
            status: "running",
            expect: "Waiting for a GitHub run started by v1.2.0-1…",
        });
    });

    it("names the workflow that never started, links it and offers to dispatch it", () => {
        const late = facts({
            tagworkflows: {
                workflows: [wf({ dispatch: true, url: "https://github.com/o/r/actions/workflows/release.yml" })],
                overdue: true,
            },
        });
        const build = releaseRun(late, steps).phases[2];
        expect(build).toMatchObject({
            status: "waiting",
            expect: "No run of Release appeared on GitHub for v1.2.0-1: check it there, or dispatch it.",
            links: [{ label: "Release on GitHub", url: "https://github.com/o/r/actions/workflows/release.yml" }],
            action: { kind: "dispatch", workflow: "release.yml", label: "Dispatch Release" },
        });
        expect(build.action.kind === "dispatch" && build.action.confirm).toContain("v1.2.0-1");
        const publish = releaseRun(late, buildStep).phases[3];
        expect(publish).toMatchObject({ status: "waiting", action: { kind: "dispatch", workflow: "release.yml" } });
    });

    it("only links a workflow that cannot be dispatched", () => {
        const late = facts({ tagworkflows: { workflows: [wf({ file: "ship.yml", name: "" })], overdue: true } });
        const build = releaseRun(late, steps).phases[2];
        expect(build).toMatchObject({
            status: "waiting",
            expect: "No run of ship.yml appeared on GitHub for v1.2.0-1: check it there.",
        });
        expect(build.action).toBeUndefined();
    });

    it("ends the publish phase once the tag's runs ended and none of its workflows publishes", () => {
        const ci = facts({
            runs: [run()],
            tagworkflows: { workflows: [wf({ name: "CI", publishes: false })], overdue: false },
        });
        expect(releaseRun(ci, steps).phases[3]).toMatchObject({
            status: "done",
            expect: "Nothing to publish for this tag: CI ran, none publishes a GitHub release.",
        });
        const publishing = facts({ runs: [run()], tagworkflows: { workflows: [wf()], overdue: false } });
        expect(releaseRun(publishing, steps).phases[3].status).toBe("running");
    });

    it("follows a declared publish step rather than the tag's workflows", () => {
        const declared = [
            ...steps,
            { id: "deploy", title: "Deploy", phase: "publish" as const, run: "molten release dispatch deploy.yml" },
        ];
        const r = releaseRun(facts({ tagworkflows: { workflows: [], overdue: false } }), declared);
        expect(r.phases[3]).toMatchObject({ status: "waiting", action: { kind: "step", step: "deploy" } });
    });
});
