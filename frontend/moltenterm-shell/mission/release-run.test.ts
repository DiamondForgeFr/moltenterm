// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PipelineReleaseStep } from "./mission-model";
import { ReleaseFacts, releaseRun, ReleaseStepFact, stepsByPhase } from "./release-run";

const steps: PipelineReleaseStep[] = [
    { id: "warm", title: "Warm the cache", phase: "prepare", run: "x" },
    { id: "promote", title: "Promote develop", phase: "prepare", run: "x" },
    { id: "draft", title: "Prepare the cut", phase: "cut", run: "x" },
    { id: "rewrite", title: "Rewrite the notes", phase: "cut", notes: true, run: "x" },
    { id: "finalize", title: "Cut", phase: "cut", confirm: "{tag} is public once pushed.", run: "x" },
    { id: "verify", title: "Verify the endpoint", phase: "publish", run: "x" },
    { id: "sync", title: "Carry back to develop", phase: "back", run: "x" },
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
        session: { tag: "v1.2.0-1", version: "1.2.0", channel: "rc", startedat: 1 },
        tag: "v1.2.0-1",
        version: "1.2.0",
        channel: "rc",
        tagexists: false,
        trunk: "develop",
        steps: {},
        runs: [],
        jobs: [],
        ontrunk: false,
        ...extra,
    };
}

const statuses = (f: ReleaseFacts) =>
    releaseRun(f, steps)
        .phases.map((p) => p.status)
        .join(",");

describe("release run (FR-MC-016)", () => {
    it("is null when nothing is followed", () => {
        expect(releaseRun(facts({ tag: "" }), steps)).toBeNull();
    });

    it("orders the declared steps by phase; without phases the first prepares", () => {
        const by = stepsByPhase(steps);
        expect(by.prepare.map((s) => s.id)).toEqual(["warm", "promote"]);
        expect(by.cut.map((s) => s.id)).toEqual(["draft", "finalize"]);
        expect(
            stepsByPhase([
                { id: "a", run: "x" },
                { id: "b", run: "x" },
            ]).cut.map((s) => s.id)
        ).toEqual(["b"]);
    });

    it("follows the preparation, and offers its retry when it failed", () => {
        const running = releaseRun(
            facts({ steps: { prepare: ok({ state: "running", running: true, phases: ["warm", "promote"] }) } }),
            steps
        );
        expect(running.phases[0]).toMatchObject({ status: "running", expect: "Promote develop…" });
        expect(running.current).toBe("prepare");
        const failed = releaseRun(
            facts({ steps: { prepare: ok({ state: "failure", exit: 1, tail: ["red CI"] }) } }),
            steps
        );
        expect(failed.phases[0]).toMatchObject({
            status: "failed",
            cause: "The preparation failed: red CI",
            action: { kind: "step", step: "prepare", label: "Retry the preparation" },
        });
        expect(statuses(facts())).toBe("waiting,todo,todo,todo,todo");
    });

    it("runs the cut steps in order, then asks to read the notes and confirm the cut", () => {
        const prepared = { prepare: ok() };
        const first = releaseRun(facts({ steps: prepared }), steps);
        expect(first.phases[1]).toMatchObject({
            status: "waiting",
            expect: "Next: Prepare the cut.",
            action: { kind: "step", step: "draft" },
        });
        const cut = releaseRun(facts({ steps: { ...prepared, draft: ok() }, notes: "/p/releases/v1.2.0-1.md" }), steps);
        expect(cut.phases[1]).toMatchObject({
            status: "waiting",
            expect: "Read the public notes, fix them if needed, then cut.",
            action: {
                kind: "step",
                step: "finalize",
                label: "Cut v1.2.0-1",
                confirm: "v1.2.0-1 is public once pushed.",
            },
        });
        expect(cut.editNotes).toBe(true);
        expect(cut.notesStep.id).toBe("rewrite");
        const rewriting = releaseRun(
            facts({ steps: { ...prepared, draft: ok(), rewrite: ok({ state: "running", running: true }) } }),
            steps
        );
        expect(rewriting.phases[1].expect).toBe("Rewriting the public notes…");
        const broken = releaseRun(
            facts({
                steps: {
                    ...prepared,
                    draft: ok(),
                    finalize: ok({ state: "failure", exit: 1, tail: ["push refused"] }),
                },
            }),
            steps
        );
        expect(broken.phases[1]).toMatchObject({
            status: "failed",
            cause: "“Cut” failed: push refused",
            action: { label: "Run “Cut” again" },
        });
    });

    it("follows the GitHub runs of the tag, and offers to rerun the failed jobs", () => {
        const run = (status: string, conclusion: string) => ({
            databaseId: 7,
            workflowName: "release.yml",
            headBranch: "v1.2.0-1",
            status,
            conclusion,
            url: "https://gh/run/7",
            createdAt: "2026-10-03T10:00:00Z",
        });
        const job = (name: string, conclusion: string) => ({
            name,
            status: "completed",
            conclusion,
            startedAt: "",
            completedAt: "",
            url: "",
        });
        expect(releaseRun(facts({ tagexists: true }), steps).phases[2]).toMatchObject({
            status: "running",
            expect: "Waiting for a GitHub run started by v1.2.0-1…",
        });
        const building = releaseRun(
            facts({
                tagexists: true,
                runs: [run("in_progress", "")],
                jobs: [job("macos", "success"), { ...job("linux", ""), status: "in_progress" }],
            }),
            steps
        );
        expect(building.phases[2]).toMatchObject({ status: "running", expect: "1/2 jobs done." });
        expect(building.phases[0].status).toBe("done");
        expect(building.phases[1]).toMatchObject({ status: "done", expect: "v1.2.0-1 is tagged." });
        const red = releaseRun(
            facts({ tagexists: true, runs: [run("completed", "failure")], jobs: [job("windows", "failure")] }),
            steps
        );
        expect(red.phases[2]).toMatchObject({
            status: "failed",
            cause: "Failed: windows.",
            action: { kind: "rerun" },
            links: [{ label: "release.yml", url: "https://gh/run/7" }],
        });
    });

    it("waits for a public draft's promotion, then runs the publish steps", () => {
        const built = { tagexists: true, runs: [], release: null as any };
        const draft = releaseRun(
            facts({
                ...built,
                channel: "public",
                tag: "v1.2.0",
                release: { tagName: "v1.2.0", isDraft: true, isPrerelease: false, url: "u" },
            }),
            steps
        );
        expect(draft.phases[3]).toMatchObject({ status: "waiting" });
        expect(draft.phases[3].expect).toMatch(/^Publish the draft on GitHub/);
        const live = releaseRun(
            facts({ ...built, release: { tagName: "v1.2.0-1", isDraft: false, isPrerelease: true, url: "u" } }),
            steps
        );
        expect(live.phases[3]).toMatchObject({
            status: "waiting",
            expect: "Published as a prerelease: offered to nobody, installable by hand. Next: Verify the endpoint.",
            action: { step: "verify" },
        });
        expect(live.phases[4]).toMatchObject({ status: "todo", action: { step: "sync" } });
    });

    it("ends once the release is back on the trunk", () => {
        const release = { tagName: "v1.2.0-1", isDraft: false, isPrerelease: true, url: "u" };
        const done = { verify: ok() };
        const pr = releaseRun(
            facts({
                tagexists: true,
                release,
                steps: done,
                backpr: { number: 9, url: "pr", title: "", headRefName: "chore/sync-1.2.0" },
            }),
            steps
        );
        expect(pr.phases[4]).toMatchObject({ status: "waiting", expect: "Merge PR #9 into develop." });
        expect(pr.active).toBe(true);
        const back = releaseRun(facts({ tagexists: true, release, steps: done, ontrunk: true }), steps);
        expect(statuses(facts({ tagexists: true, release, steps: done, ontrunk: true }))).toBe(
            "done,done,done,done,done"
        );
        expect(back.active).toBe(false);
        expect(back.current).toBeNull();
    });

    it("publishes through the project's own steps when there is no GitHub release", () => {
        const own = [...steps, { id: "compile", title: "Compile", phase: "build" as const, run: "x" }];
        const run = releaseRun(facts({ tagexists: true, release: null, githuberror: "no gh", runs: [] }), own);
        expect(run.phases[2]).toMatchObject({ status: "waiting", action: { step: "compile" } });
        const built = releaseRun(facts({ tagexists: true, githuberror: "no gh", steps: { compile: ok() } }), own);
        expect(built.phases[3]).toMatchObject({ status: "waiting", expect: "Next: Verify the endpoint." });
    });
});
