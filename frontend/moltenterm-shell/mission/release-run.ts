// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A release on its way, phase by phase (FR-MC-016), as Notulia's devReleaseRun: what is done, what it waits on, and
// why it is stuck when it is. Everything is derived from the facts wavesrv reads (pkg/molten/mission/release_facts.go)
// and from the steps the pipeline declares per phase; MoltenTerm only orders them and shows their state.

import { PipelineReleaseStep, ReleasePhase } from "./mission-model";
import { ReleaseChannel, ReleaseSession, releaseStepPhases } from "./release-model";

export type PhaseStatus = "todo" | "running" | "waiting" | "done" | "failed";

// must match ReleaseStepFact in pkg/molten/mission/release_facts.go
export type ReleaseStepFact = {
    runid: string;
    state: string;
    running: boolean;
    exit?: number;
    tail: string[];
    phases: string[];
};

export type ReleaseGhRun = {
    databaseId: number;
    workflowName: string;
    headBranch: string;
    status: string;
    conclusion: string;
    url: string;
    createdAt: string;
};

export type ReleaseGhJob = {
    name: string;
    status: string;
    conclusion: string;
    startedAt: string;
    completedAt: string;
    url: string;
};

// must match ReleaseFacts in pkg/molten/mission/release_facts.go
export type ReleaseFacts = {
    session?: ReleaseSession;
    tag?: string;
    version?: string;
    channel?: ReleaseChannel;
    tagexists: boolean;
    trunk?: string;
    // The declared steps' last runs, by their own ids only.
    steps: Record<string, ReleaseStepFact>;
    // The preparation's last run, which is none of the declared steps (#230).
    preparation?: ReleaseStepFact;
    notes?: string;
    // The notes were written since the release started: a step of this release drafted them.
    notesdrafted?: boolean;
    // The project is not on GitHub: no run, release or pull request of it is to be waited for.
    nogithub?: boolean;
    githuberror?: string;
    runs: ReleaseGhRun[];
    jobs: ReleaseGhJob[];
    release?: { tagName: string; isDraft: boolean; isPrerelease: boolean; url: string };
    ontrunk: boolean;
    backpr?: { number: number; url: string; title: string; headRefName: string };
};

export type PhaseLink = { label: string; url: string };

export type PhaseAction =
    | { kind: "step"; step: string; label: string; confirm?: string }
    | { kind: "prepare"; label: string }
    | { kind: "rerun"; label: string };

export type Phase = {
    id: ReleasePhase;
    title: string;
    status: PhaseStatus;
    // What moves it forward, said to the person watching.
    expect: string;
    cause?: string;
    links: PhaseLink[];
    action?: PhaseAction;
    // After a failure, the step before the failed one again: what a failed cut needs once it committed (Notulia
    // prepares the cut again rather than finalizing twice).
    redo?: PhaseAction;
    // The step whose last lines the phase shows.
    log?: ReleaseStepFact;
};

export type ReleaseRun = {
    active: boolean;
    tag: string;
    channel: ReleaseChannel;
    phases: Phase[];
    current: ReleasePhase;
    // The public notes can be edited: the next step is the cut that cannot be taken back.
    editNotes: boolean;
    notesStep: PipelineReleaseStep;
    // Changes whenever the notes step ran again: the editor then reads the notes again.
    notesRevision: string;
};

// must match ReleasePreparationStepId in pkg/molten/mission/release.go: no declared step id can start with "@".
export const PreparationStep = "@preparation";

export const PhaseTitles: Record<ReleasePhase, string> = {
    prepare: "Prepare",
    cut: "Cut",
    build: "Build",
    publish: "Publish",
    back: "Back to the trunk",
};

const FailedConclusions = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

const stepTitle = (step: PipelineReleaseStep) => step.title || step.id;

const lastWords = (fact: ReleaseStepFact) => fact.tail[fact.tail.length - 1] ?? "no message";

// A step that ended badly, or stopped without saying how it ended.
const broke = (fact: ReleaseStepFact) => fact != null && !fact.running && fact.state !== "success";

// The steps of each phase, in their declared order. As declared (a step without a phase in a phased list joins the
// phase of the step before it); when no step declares one, the first prepares and the others run in order through the
// cut, but those that had not run once the tag is pushed come after it, back to the trunk: Notulia's sync-back (#230).
export function stepsByPhase(
    steps: readonly PipelineReleaseStep[],
    facts?: ReleaseFacts
): Record<ReleasePhase, PipelineReleaseStep[]> {
    const rtn: Record<ReleasePhase, PipelineReleaseStep[]> = { prepare: [], cut: [], build: [], publish: [], back: [] };
    const list = steps ?? [];
    const phases = releaseStepPhases(list);
    let lastRan = -1;
    if (facts?.tagexists) {
        list.forEach((step, i) => {
            if (phases[i] == null && !step.notes && facts.steps?.[step.id] != null) {
                lastRan = i;
            }
        });
    }
    list.forEach((step, i) => {
        if (step.notes) {
            return;
        }
        const phase = phases[i] ?? (lastRan >= 0 && i > lastRan ? "back" : "cut");
        if (phase in rtn) {
            rtn[phase].push(step);
        }
    });
    return rtn;
}

type Sequence = { running?: PipelineReleaseStep; failed?: PipelineReleaseStep; next?: PipelineReleaseStep };

// Where a phase's steps stand: they run in order, each on its click.
function sequence(steps: PipelineReleaseStep[], facts: ReleaseFacts): Sequence {
    const running = steps.find((s) => facts.steps[s.id]?.running);
    if (running) {
        return { running };
    }
    for (const step of steps) {
        const fact = facts.steps[step.id];
        if (fact?.state === "success") {
            continue;
        }
        return broke(fact) ? { failed: step } : { next: step };
    }
    return {};
}

// A step's confirmation, with the release's words in it.
function confirmOf(step: PipelineReleaseStep, facts: ReleaseFacts): string {
    if (!step.confirm) {
        return undefined;
    }
    return step.confirm
        .split("{tag}")
        .join(facts.tag ?? "")
        .split("{version}")
        .join(facts.version ?? "");
}

function runAgain(step: PipelineReleaseStep, facts: ReleaseFacts): PhaseAction {
    return { kind: "step", step: step.id, label: `Run “${stepTitle(step)}” again`, confirm: confirmOf(step, facts) };
}

function runStep(step: PipelineReleaseStep, facts: ReleaseFacts): PhaseAction {
    return { kind: "step", step: step.id, label: stepTitle(step), confirm: confirmOf(step, facts) };
}

// The phase as its steps say, when they are not done yet: running, failed or waiting for a click.
function stepsPhase(base: Phase, steps: PipelineReleaseStep[], facts: ReleaseFacts): Phase {
    const seq = sequence(steps, facts);
    if (seq.running) {
        return { ...base, status: "running", expect: `${stepTitle(seq.running)}…`, log: facts.steps[seq.running.id] };
    }
    if (seq.failed) {
        const fact = facts.steps[seq.failed.id];
        const before = steps[steps.indexOf(seq.failed) - 1];
        return {
            ...base,
            status: "failed",
            expect: "Fix it, then run it again.",
            cause:
                fact.state === "lost"
                    ? `“${stepTitle(seq.failed)}” stopped without a word (the machine slept?).`
                    : `“${stepTitle(seq.failed)}” failed: ${lastWords(fact)}`,
            action: runAgain(seq.failed, facts),
            redo: before ? runAgain(before, facts) : undefined,
            log: fact,
        };
    }
    if (seq.next) {
        return {
            ...base,
            status: "waiting",
            expect: `Next: ${stepTitle(seq.next)}.`,
            action: runStep(seq.next, facts),
        };
    }
    return null;
}

function prepare(facts: ReleaseFacts, steps: PipelineReleaseStep[]): Phase {
    const base: Phase = { id: "prepare", title: PhaseTitles.prepare, status: "done", expect: "", links: [] };
    if (facts.tagexists) {
        return { ...base, expect: "Prepared." };
    }
    if (steps.length === 0) {
        return { ...base, expect: "The pipeline declares nothing to prepare." };
    }
    const retry: PhaseAction = { kind: "prepare", label: "Retry the preparation" };
    const fact = facts.preparation;
    if (fact?.running) {
        const at = steps.find((s) => s.id === fact.phases[fact.phases.length - 1]);
        return { ...base, status: "running", expect: `${at ? stepTitle(at) : "Preparing"}…`, log: fact };
    }
    if (broke(fact)) {
        return {
            ...base,
            status: "failed",
            expect: "Fix it, then retry the preparation.",
            cause:
                fact.state === "lost"
                    ? "The preparation stopped without a word (the machine slept?)."
                    : `The preparation failed: ${lastWords(fact)}`,
            action: retry,
            log: fact,
        };
    }
    if (fact?.state === "success") {
        return { ...base, expect: steps.map(stepTitle).join(", ") + ": done." };
    }
    return { ...base, status: "waiting", expect: "The preparation did not run: start it again.", action: retry };
}

function cut(
    facts: ReleaseFacts,
    tag: string,
    steps: PipelineReleaseStep[],
    notesStep: PipelineReleaseStep,
    ready: boolean
): Phase {
    const base: Phase = { id: "cut", title: PhaseTitles.cut, status: "todo", expect: "", links: [] };
    if (facts.tagexists) {
        return { ...base, status: "done", expect: `${tag} is tagged.` };
    }
    if (!ready) {
        return { ...base, expect: "Waits for the preparation." };
    }
    if (notesStep && facts.steps[notesStep.id]?.running) {
        return { ...base, status: "running", expect: "Rewriting the public notes…", log: facts.steps[notesStep.id] };
    }
    if (steps.length === 0) {
        return { ...base, status: "waiting", expect: `Cut ${tag} at the terminal: the pipeline declares no cut step.` };
    }
    const phase = stepsPhase(base, steps, facts);
    if (phase == null) {
        const last = steps[steps.length - 1];
        return {
            ...base,
            status: "failed",
            expect: "Run the cut again, or cut at the terminal.",
            cause: `The cut steps ran, but ${tag} is not on origin.`,
            action: runAgain(last, facts),
        };
    }
    if (phase.status !== "waiting" || phase.action?.kind !== "step") {
        return phase;
    }
    const action = phase.action;
    const declared = action.confirm;
    // No step says which one pushes the tag: once the steps before it ran and drafted the notes for this release, the
    // next one is the cut, read and confirmed as Notulia's finalize is (#230).
    const inferred = !declared && !steps.some((s) => s.confirm) && !!facts.notes && !!facts.notesdrafted;
    if (!declared && !inferred) {
        return phase;
    }
    const confirm =
        declared ?? `“${action.label}” may push ${tag}: once pushed, the tag is public and cannot be taken back.`;
    return {
        ...phase,
        action: { ...action, label: declared ? `Cut ${tag}` : action.label, confirm },
        expect: facts.notes
            ? "Read the public notes, fix them if needed, then cut."
            : `Then cut: ${tag} becomes public once pushed.`,
    };
}

function build(facts: ReleaseFacts, tag: string, steps: PipelineReleaseStep[]): Phase {
    const base: Phase = { id: "build", title: PhaseTitles.build, status: "todo", expect: "", links: [] };
    if (!facts.tagexists) {
        return { ...base, expect: "Starts once the tag is pushed." };
    }
    if (steps.length > 0) {
        return stepsPhase(base, steps, facts) ?? { ...base, status: "done", expect: "Built." };
    }
    if (facts.nogithub) {
        return { ...base, status: "done", expect: "Nothing to follow: not on GitHub, and no build step declared." };
    }
    const runs = facts.runs ?? [];
    const links = runs.map((r) => ({ label: r.workflowName, url: r.url }));
    if (runs.length === 0) {
        if (facts.release) {
            return { ...base, status: "done", expect: "No workflow ran for the tag on GitHub." };
        }
        if (facts.githuberror) {
            return { ...base, status: "waiting", expect: "GitHub could not be read.", cause: facts.githuberror };
        }
        return { ...base, status: "running", expect: `Waiting for a GitHub run started by ${tag}…` };
    }
    const newest = new Map<string, ReleaseGhRun>();
    for (const run of runs) {
        const known = newest.get(run.workflowName);
        if (!known || run.createdAt > known.createdAt) {
            newest.set(run.workflowName, run);
        }
    }
    const latest = [...newest.values()];
    if (latest.some((r) => r.status !== "completed")) {
        const jobs = facts.jobs ?? [];
        const done = jobs.filter((j) => j.status === "completed").length;
        return { ...base, links, status: "running", expect: `${done}/${jobs.length || "?"} jobs done.` };
    }
    const red = latest.filter((r) => FailedConclusions.has(r.conclusion));
    if (red.length === 0) {
        return { ...base, links, status: "done", expect: "Built on GitHub." };
    }
    const failedJobs = (facts.jobs ?? []).filter((j) => FailedConclusions.has(j.conclusion)).map((j) => j.name);
    return {
        ...base,
        links,
        status: "failed",
        expect: "Rerun the failed jobs, or fix and cut again.",
        cause: failedJobs.length
            ? `Failed: ${failedJobs.join(", ")}.`
            : `${red.map((r) => r.workflowName).join(", ")} ended in “${red[0].conclusion}”.`,
        action: { kind: "rerun", label: "Rerun the failed jobs" },
    };
}

function publish(facts: ReleaseFacts, channel: ReleaseChannel, steps: PipelineReleaseStep[], built: boolean): Phase {
    const release = facts.release;
    const links = release ? [{ label: "The release", url: release.url }] : [];
    const base: Phase = { id: "publish", title: PhaseTitles.publish, status: "todo", expect: "", links };
    if (!built) {
        return { ...base, expect: "Waits for the build." };
    }
    if (!release && steps.length > 0) {
        // Published by the project's own steps, not as a GitHub release.
        return stepsPhase(base, steps, facts) ?? { ...base, status: "done", expect: "Published." };
    }
    if (!release && facts.nogithub) {
        return { ...base, status: "done", expect: "Nothing to follow: not on GitHub, and no publish step declared." };
    }
    if (!release) {
        if (facts.githuberror) {
            return { ...base, status: "waiting", expect: "GitHub could not be read.", cause: facts.githuberror };
        }
        return { ...base, status: "running", expect: `Waiting for the GitHub release of ${facts.tag}…` };
    }
    if (release.isDraft) {
        return {
            ...base,
            status: "waiting",
            expect:
                channel === "public"
                    ? "Publish the draft on GitHub (link below): at that moment it goes to every user."
                    : "Publish the draft on GitHub (link below).",
        };
    }
    const said =
        channel === "rc"
            ? "Published as a prerelease: offered to nobody, installable by hand."
            : "Published: offered to all users.";
    const phase = stepsPhase(base, steps, facts);
    if (phase == null) {
        return { ...base, status: "done", expect: said };
    }
    return phase.status === "waiting" ? { ...phase, expect: `${said} ${phase.expect}` } : phase;
}

function back(facts: ReleaseFacts, tag: string, steps: PipelineReleaseStep[], published: boolean): Phase {
    const trunk = facts.trunk || "the trunk";
    const links = facts.backpr ? [{ label: `PR #${facts.backpr.number}`, url: facts.backpr.url }] : [];
    const base: Phase = { id: "back", title: PhaseTitles.back, status: "todo", expect: "", links };
    if (facts.tagexists && facts.ontrunk) {
        return { ...base, status: "done", expect: `The release is back on ${trunk}.` };
    }
    if (!facts.tagexists) {
        return { ...base, expect: "After the cut." };
    }
    if (facts.backpr) {
        return { ...base, status: "waiting", expect: `Merge PR #${facts.backpr.number} into ${trunk}.` };
    }
    if (steps.length === 0) {
        return { ...base, status: published ? "waiting" : "todo", expect: `Bring ${tag} back to ${trunk}.` };
    }
    const phase = stepsPhase(base, steps, facts);
    if (phase == null) {
        return { ...base, status: "waiting", expect: `Waiting for ${tag} to reach ${trunk}.` };
    }
    // Possible from the tag on, but only the next thing to do once the release is out.
    return phase.status === "waiting" && !published ? { ...phase, status: "todo" } : phase;
}

// The release followed, or null when there is none; `active` is false once all five phases are done.
export function releaseRun(facts: ReleaseFacts, declared: readonly PipelineReleaseStep[]): ReleaseRun {
    if (facts?.tag == null || facts.tag === "") {
        return null;
    }
    const tag = facts.tag;
    const channel = facts.channel ?? (tag.includes("-") ? "rc" : "public");
    const byPhase = stepsByPhase(declared, facts);
    const notesStep = (declared ?? []).find((s) => s.notes) ?? null;
    const p = prepare(facts, byPhase.prepare);
    const c = cut(facts, tag, byPhase.cut, notesStep, p.status === "done");
    const b = build(facts, tag, byPhase.build);
    const pub = publish(facts, channel, byPhase.publish, b.status === "done");
    const phases = [p, c, b, pub, back(facts, tag, byPhase.back, pub.status === "done")];
    const current = phases.find((ph) => ph.status !== "done")?.id ?? null;
    const editNotes = c.status === "waiting" && !!facts.notes && c.action?.kind === "step" && c.action.confirm != null;
    const rewritten = notesStep ? facts.steps[notesStep.id] : null;
    const notesRevision = rewritten ? `${rewritten.runid}:${rewritten.state}` : "";
    return { active: current != null, tag, channel, phases, current, editNotes, notesStep, notesRevision };
}
