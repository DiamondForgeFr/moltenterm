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

// SaaSFoundryAI's v1.1.0 (#1091): the last manual cut step before the pull-request flow, with backticks in its text.
const prFlow: PipelineReleaseStep[] = [
    { id: "prepare", title: "Bump on rc-{version}", phase: "prepare", run: "molten release prepare {tag} --pr" },
    {
        id: "changelog-en",
        title: "Write the [{version}] section of docs/changelog.md",
        phase: "cut",
        manual: "en",
        run: undefined,
    },
    {
        id: "changelog-fr",
        title: "Write the [{version}] section of docs/fr/changelog.md",
        phase: "cut",
        manual: "fr",
        run: undefined,
    },
    {
        id: "agents-version",
        title: "Set the current version line of AGENTS.md to {version}",
        phase: "cut",
        manual: "On rc-{version}, set the line to '- Current version: {version} (npm package `saasfoundryai-cli`)'.",
        run: undefined,
    },
    { id: "rewrite-notes", title: "Rewrite the public notes", notes: true, run: "molten release notes {tag}" },
    {
        id: "open-pr",
        title: "Commit the release on rc-{version} and open its pull request to master",
        phase: "cut",
        confirm: "Pushes rc-{version}.",
        run: "molten release open-pr {tag}",
    },
    { id: "tag", title: "Tag", phase: "cut", confirm: "{tag} is public once pushed.", run: "molten release tag {tag}" },
];

describe("the manual cut step before the pull-request flow (#1091)", () => {
    const at = (done: string[]) =>
        releaseRun(
            facts({
                tag: "v1.1.0",
                version: "1.1.0",
                session: { tag: "v1.1.0", version: "1.1.0", channel: "public", startedat: 1 },
                notes: "/r/releases/v1.1.0.md",
                notesdrafted: true,
                steps: Object.fromEntries(done.map((id) => [id, ok()])),
            }),
            prFlow
        ).phases.find((p) => p.id === "cut");

    it("offers Mark as done for agents-version, its text with the release's words and its backticks", () => {
        const cut = at(["changelog-en", "changelog-fr"]);
        expect(cut.action).toMatchObject({ kind: "step", step: "agents-version" });
        expect(cut.action.label).toBe("Mark as done: Set the current version line of AGENTS.md to 1.1.0");
        expect(cut.action.kind === "step" && cut.action.confirm).toContain("runs nothing");
        expect(cut.manual).toBe(
            "On rc-1.1.0, set the line to '- Current version: 1.1.0 (npm package `saasfoundryai-cli`)'."
        );
    });

    it("goes on to the pull request once it is recorded", () => {
        const cut = at(["changelog-en", "changelog-fr", "agents-version"]);
        expect(cut.manual).toBeUndefined();
        expect(cut.action).toMatchObject({ kind: "step", step: "open-pr", confirm: "Pushes rc-1.1.0." });
    });
});
