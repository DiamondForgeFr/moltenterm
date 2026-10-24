// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PipelineReleaseStep } from "./mission-model";
import { ReleaseFacts, releaseRun, ReleaseStepFact } from "./release-run";

const steps: PipelineReleaseStep[] = [
    { id: "prepare", title: "Prepare", phase: "prepare", run: "x" },
    {
        id: "merge-ours",
        title: "Merge master with -s ours",
        phase: "cut",
        manual: "git merge -s ours origin/master for {version}",
        run: undefined,
    },
    { id: "finalize", title: "Cut", phase: "cut", confirm: "{tag} is public once pushed.", run: "x" },
    {
        id: "docs",
        title: "Deploy the docs",
        phase: "publish",
        run: "molten release dispatch deploy-docs.yml --ref {tag}",
    },
];

const ok = (extra: Partial<ReleaseStepFact> = {}): ReleaseStepFact => ({
    runid: "r",
    state: "success",
    running: false,
    exit: 0,
    tail: [],
    phases: [],
    ...extra,
});

function facts(extra: Partial<ReleaseFacts> = {}): ReleaseFacts {
    return {
        session: { tag: "v1.2.0", version: "1.2.0", channel: "public", startedat: 1 },
        tag: "v1.2.0",
        version: "1.2.0",
        channel: "public",
        tagexists: false,
        trunk: "develop",
        steps: {},
        preparation: ok(),
        runs: [],
        jobs: [],
        ontrunk: false,
        ...extra,
    };
}

describe("manual and dispatch release steps (FR-MC-037)", () => {
    it("waits on a manual step with its instructions and a Mark as done that asks to confirm", () => {
        const run = releaseRun(facts(), steps);
        const cut = run.phases.find((p) => p.id === "cut");
        expect(cut.status).toBe("waiting");
        expect(cut.manual).toBe("git merge -s ours origin/master for 1.2.0");
        expect(cut.action).toMatchObject({ kind: "step", step: "merge-ours" });
        expect(cut.action.label).toContain("Merge master with -s ours");
        expect(cut.action.kind === "step" && cut.action.confirm).toBeTruthy();
        expect(run.editNotes).toBe(false);
    });

    it("goes on to the cut once the manual step is done", () => {
        const cut = releaseRun(facts({ steps: { "merge-ours": ok() } }), steps).phases.find((p) => p.id === "cut");
        expect(cut.manual).toBeUndefined();
        expect(cut.action).toMatchObject({ step: "finalize" });
    });

    it("shows a dispatch step's pending approval", () => {
        const f = facts({
            tagexists: true,
            release: { tagName: "v1.2.0", isDraft: false, isPrerelease: false, url: "https://r" },
            runs: [
                {
                    databaseId: 1,
                    workflowName: "Publish",
                    headBranch: "v1.2.0",
                    status: "completed",
                    conclusion: "success",
                    url: "https://run/1",
                    createdAt: "x",
                },
            ],
            steps: {
                "merge-ours": ok(),
                finalize: ok(),
                docs: ok({
                    running: true,
                    state: "running",
                    approval: { environment: "github-pages", url: "https://run/9" },
                }),
            },
        });
        const publish = releaseRun(f, steps).phases.find((p) => p.id === "publish");
        expect(publish.status).toBe("waiting");
        expect(publish.approval.environment).toBe("github-pages");
        expect(publish.links.map((l) => l.url)).toContain("https://run/9");
    });

    it("shows a tag run waiting for an environment approval", () => {
        const f = facts({
            tagexists: true,
            runs: [
                {
                    databaseId: 7,
                    workflowName: "Publish",
                    headBranch: "v1.2.0",
                    status: "waiting",
                    conclusion: "",
                    url: "https://run/7",
                    createdAt: "x",
                },
            ],
            approvals: [{ environment: "npm-production", url: "https://run/7", workflow: "Publish" }],
            steps: { "merge-ours": ok(), finalize: ok() },
        });
        const build = releaseRun(f, steps).phases.find((p) => p.id === "build");
        expect(build.status).toBe("waiting");
        expect(build.expect).toContain("npm-production");
    });
});
