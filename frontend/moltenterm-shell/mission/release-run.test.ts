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
            facts({ preparation: ok({ state: "running", running: true, phases: ["warm", "promote"] }) }),
            steps
        );
        expect(running.phases[0]).toMatchObject({ status: "running", expect: "Promote develop…" });
        expect(running.current).toBe("prepare");
        const failed = releaseRun(facts({ preparation: ok({ state: "failure", exit: 1, tail: ["red CI"] }) }), steps);
        expect(failed.phases[0]).toMatchObject({
            status: "failed",
            cause: "The preparation failed: red CI",
            action: { kind: "prepare", label: "Retry the preparation" },
        });
        expect(statuses(facts())).toBe("waiting,todo,todo,todo,todo");
    });

    it("runs the cut steps in order, then asks to read the notes and confirm the cut", () => {
        const prepared = {};
        const first = releaseRun(facts({ preparation: ok() }), steps);
        expect(first.phases[1]).toMatchObject({
            status: "waiting",
            expect: "Next: Prepare the cut.",
            action: { kind: "step", step: "draft" },
        });
        const cut = releaseRun(
            facts({ preparation: ok(), steps: { ...prepared, draft: ok() }, notes: "/p/releases/v1.2.0-1.md" }),
            steps
        );
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
            facts({
                preparation: ok(),
                steps: { ...prepared, draft: ok(), rewrite: ok({ state: "running", running: true }) },
            }),
            steps
        );
        expect(rewriting.phases[1].expect).toBe("Rewriting the public notes…");
        const broken = releaseRun(
            facts({
                preparation: ok(),
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
            action: { label: "Run “Cut” again", confirm: "v1.2.0-1 is public once pushed." },
            redo: { kind: "step", step: "draft", label: "Run “Prepare the cut” again" },
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

// Notulia's .molten/project.json, which declares no phase and a step of its own named "prepare" (#230).
const notulia: PipelineReleaseStep[] = [
    { id: "warm-cache", title: "Warm the release cache", run: "x" },
    { id: "promote", title: "Promote develop onto main", run: "x" },
    { id: "prepare", title: "Prepare the cut", run: "x" },
    { id: "finalize", title: "Cut", run: "x" },
    { id: "sync-back", title: "Carry back", run: "x" },
];

describe("a pipeline without phases (#230)", () => {
    const step = (f: ReleaseFacts) => {
        const run = releaseRun(f, notulia);
        const action = run.phases.find((p) => p.id === run.current)?.action;
        return action?.kind === "step" ? action.step : action?.kind;
    };

    it("never reads the preparation as the project's own prepare step", () => {
        expect(step(facts({ preparation: ok() }))).toBe("promote");
        expect(step(facts({ preparation: ok(), steps: { promote: ok() } }))).toBe("prepare");
        expect(step(facts({ preparation: ok(), steps: { promote: ok(), prepare: ok() } }))).toBe("finalize");
    });

    it("runs every step in order, the ones left after the tag back to the trunk", () => {
        const ran = { promote: ok(), prepare: ok(), finalize: ok() };
        const by = stepsByPhase(notulia, facts({ tagexists: true, steps: ran }));
        expect(by.prepare.map((s) => s.id)).toEqual(["warm-cache"]);
        expect(by.cut.map((s) => s.id)).toEqual(["promote", "prepare", "finalize"]);
        expect(by.back.map((s) => s.id)).toEqual(["sync-back"]);
        const published = releaseRun(
            facts({
                tagexists: true,
                steps: ran,
                release: { tagName: "v1.2.0-1", isDraft: false, isPrerelease: true, url: "u" },
            }),
            notulia
        );
        expect(published.current).toBe("back");
        expect(published.phases[4]).toMatchObject({ status: "waiting", action: { step: "sync-back" } });
        // A tag cut at the terminal, with no step run here: nothing is guessed to come after it.
        expect(stepsByPhase(notulia, facts({ tagexists: true })).back).toEqual([]);
    });

    it("reads the step after the notes were drafted as the cut, and confirms it", () => {
        const drafted = facts({
            preparation: ok(),
            steps: { promote: ok(), prepare: ok() },
            notes: "/p-release/releases/v1.2.0-1.md",
            notesdrafted: true,
        });
        const run = releaseRun(drafted, notulia);
        expect(run.editNotes).toBe(true);
        expect(run.phases[1].action).toMatchObject({ step: "finalize", label: "Cut" });
        expect(run.phases[1].action.kind === "step" && run.phases[1].action.confirm).toContain("v1.2.0-1");
        // Notes that were there before the release are no sign of which step cuts.
        const old = releaseRun({ ...drafted, notesdrafted: false }, notulia);
        expect(old.editNotes).toBe(false);
    });

    it("offers the step before a failed one again", () => {
        const run = releaseRun(
            facts({
                preparation: ok(),
                steps: { promote: ok(), prepare: ok(), finalize: ok({ state: "failure", exit: 1, tail: ["nope"] }) },
            }),
            notulia
        );
        expect(run.phases[1]).toMatchObject({
            status: "failed",
            action: { step: "finalize" },
            redo: { step: "prepare" },
        });
    });

    it("has nothing to wait for on GitHub when the project is not there", () => {
        const run = releaseRun(facts({ tagexists: true, nogithub: true, steps: { finalize: ok() } }), notulia);
        expect(run.phases.map((p) => p.status)).toEqual(["done", "done", "done", "done", "waiting"]);
        expect(run.phases[4].action).toMatchObject({ step: "sync-back" });
    });

    it("joins a step without a phase to the phase before it, in a phased list", () => {
        const by = stepsByPhase([
            { id: "a", run: "x" },
            { id: "b", phase: "cut", run: "x" },
            { id: "c", run: "x" },
            { id: "d", phase: "back", run: "x" },
        ]);
        expect(by.prepare.map((s) => s.id)).toEqual(["a"]);
        expect(by.cut.map((s) => s.id)).toEqual(["b", "c"]);
        expect(by.back.map((s) => s.id)).toEqual(["d"]);
    });
});
