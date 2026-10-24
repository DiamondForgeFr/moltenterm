// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A release on its way, phase by phase (FR-MC-016), as Notulia's devReleaseRun: what is done, what it waits on, and
// why it is stuck when it is. Everything is derived from the facts wavesrv reads (pkg/molten/mission/release_facts.go)
// and from the steps the pipeline declares per phase; MoltenTerm only orders them and shows their state.

import { t } from "../i18n/i18n";
import type { ReleaseCiAwait } from "./branch-ci";
import { labelRecord } from "./mission-i18n";
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
    // The environment the running step's GitHub run waits on for an approval (FR-MC-037).
    approval?: ReleaseApproval;
};

// must match ReleaseApproval in pkg/molten/mission/release_facts.go
export type ReleaseApproval = { environment: string; url?: string; workflow?: string };

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
    // The runs the tag started that wait for an environment approval (FR-MC-037).
    approvals?: ReleaseApproval[];
    release?: { tagName: string; isDraft: boolean; isPrerelease: boolean; url: string };
    ontrunk: boolean;
    backpr?: { number: number; url: string; title: string; headRefName: string };
    // A running step waits for a branch's GitHub CI (the promotion, #836).
    awaits?: ReleaseCiAwait;
};

export type PhaseLink = { label: string; url: string };

// busy: what the button says from the click until the backend answered (#952).
export type PhaseAction =
    | { kind: "step"; step: string; label: string; confirm?: string; busy?: string }
    | { kind: "prepare"; label: string; busy?: string }
    | { kind: "rerun"; label: string; busy?: string };

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
    // A failed step an agent can look into (#945): the step, its own run in MoltenTerm, and the GitHub runs that failed.
    failure?: PhaseFailure;
    // The instructions of the manual step the phase waits on (FR-MC-037).
    manual?: string;
    // An environment waiting for its approval on GitHub.
    approval?: ReleaseApproval;
};

// A GitHub run a failed step names: the trunk's CI a promotion waited on, or the release workflow's run.
export type FailedRun = { name: string; runid: number; url: string };

export type PhaseFailure = { step: string; runid?: string; runs: FailedRun[] };

const GithubRunUrlRe = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/actions\/runs\/(\d+)[^\s:;,)]*/g;
// What `molten release promote` says when the trunk's CI is red (pkg/molten/release/ci.go requireCi).
const PromoteRedRe = /(\S+) failed on \S+ \S+ (https:\/\/\S+?)[:,]?(\s|$)/;

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

export const PhaseTitles: Record<ReleasePhase, string> = labelRecord("mc.releaseRun.phase", [
    "prepare",
    "cut",
    "build",
    "publish",
    "back",
]);
const FailedConclusions = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

const stepTitle = (step: PipelineReleaseStep) => step.title || step.id;

const starting = (step: PipelineReleaseStep) => t("mc.releaseRun.pending.starting", { step: stepTitle(step) });

const lastWords = (fact: ReleaseStepFact) => fact.tail[fact.tail.length - 1] ?? t("mc.releaseRun.noMessage");

// A step that ended badly, or stopped without saying how it ended.
const broke = (fact: ReleaseStepFact) => fact != null && !fact.running && fact.state !== "success";

// runsInLog: the GitHub runs a step's last lines name, each once, named by the workflow the line says failed.
export function runsInLog(lines: readonly string[]): FailedRun[] {
    const rtn: FailedRun[] = [];
    for (const line of lines ?? []) {
        const named = PromoteRedRe.exec(line);
        for (const m of line.matchAll(GithubRunUrlRe)) {
            const runid = Number(m[1]);
            if (!(runid > 0) || rtn.some((r) => r.runid === runid)) {
                continue;
            }
            const name =
                named != null && named[2].startsWith(m[0]) ? named[1] : t("mc.releaseRun.resolve.run", { id: runid });
            rtn.push({ name, runid, url: m[0] });
        }
    }
    return rtn;
}

function failureOf(step: string, fact: ReleaseStepFact): PhaseFailure {
    return { step, runid: fact?.runid, runs: runsInLog(fact?.tail) };
}

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
    return {
        kind: "step",
        step: step.id,
        label: t("mc.releaseRun.runAgain", { step: stepTitle(step) }),
        confirm: confirmOf(step, facts),
        busy: starting(step),
    };
}

// A manual step's instructions, with the release's words in them.
function manualOf(step: PipelineReleaseStep, facts: ReleaseFacts): string {
    return step.manual
        .split("{tag}")
        .join(facts.tag ?? "")
        .split("{version}")
        .join(facts.version ?? "");
}

function runStep(step: PipelineReleaseStep, facts: ReleaseFacts): PhaseAction {
    if (step.manual) {
        return {
            kind: "step",
            step: step.id,
            label: t("mc.releaseRun.manualDone", { step: stepTitle(step) }),
            confirm: t("mc.releaseRun.manualConfirm", { step: stepTitle(step) }),
            busy: t("mc.releaseRun.pending.recording"),
        };
    }
    return {
        kind: "step",
        step: step.id,
        label: stepTitle(step),
        confirm: confirmOf(step, facts),
        busy: starting(step),
    };
}

// The phase as its steps say, when they are not done yet: running, failed or waiting for a click.
function stepsPhase(base: Phase, steps: PipelineReleaseStep[], facts: ReleaseFacts): Phase {
    const seq = sequence(steps, facts);
    if (seq.running) {
        const fact = facts.steps[seq.running.id];
        if (fact.approval) {
            return {
                ...base,
                status: "waiting",
                expect: t("mc.releaseRun.approval", { environment: fact.approval.environment }),
                approval: fact.approval,
                links: fact.approval.url
                    ? [...base.links, { label: t("mc.releaseRun.approvalLink"), url: fact.approval.url }]
                    : base.links,
                log: fact,
            };
        }
        return { ...base, status: "running", expect: `${stepTitle(seq.running)}…`, log: fact };
    }
    if (seq.failed) {
        const fact = facts.steps[seq.failed.id];
        const before = steps[steps.indexOf(seq.failed) - 1];
        return {
            ...base,
            status: "failed",
            expect: t("mc.releaseRun.fixRunAgain"),
            cause:
                fact.state === "lost"
                    ? t("mc.releaseRun.stepLost", { step: stepTitle(seq.failed) })
                    : t("mc.releaseRun.stepFailed", { step: stepTitle(seq.failed), words: lastWords(fact) }),
            action: runAgain(seq.failed, facts),
            redo: before ? runAgain(before, facts) : undefined,
            failure: failureOf(stepTitle(seq.failed), fact),
            log: fact,
        };
    }
    if (seq.next) {
        return {
            ...base,
            status: "waiting",
            expect: seq.next.manual
                ? t("mc.releaseRun.manualNext", { step: stepTitle(seq.next) })
                : t("mc.releaseRun.next", { step: stepTitle(seq.next) }),
            manual: seq.next.manual ? manualOf(seq.next, facts) : undefined,
            action: runStep(seq.next, facts),
        };
    }
    return null;
}

function prepare(facts: ReleaseFacts, steps: PipelineReleaseStep[]): Phase {
    const base: Phase = { id: "prepare", title: PhaseTitles.prepare, status: "done", expect: "", links: [] };
    if (facts.tagexists) {
        return { ...base, expect: t("mc.releaseRun.prepared") };
    }
    if (steps.length === 0) {
        return { ...base, expect: t("mc.releaseRun.nothingToPrepare") };
    }
    const retry: PhaseAction = {
        kind: "prepare",
        label: t("mc.releaseRun.retryPreparation"),
        busy: t("mc.releaseRun.pending.preparing"),
    };
    const fact = facts.preparation;
    if (fact?.running) {
        const at = steps.find((s) => s.id === fact.phases[fact.phases.length - 1]);
        return {
            ...base,
            status: "running",
            expect: `${at ? stepTitle(at) : t("mc.releaseRun.preparing")}…`,
            log: fact,
        };
    }
    if (broke(fact)) {
        const at = steps.find((s) => s.id === fact.phases?.[fact.phases.length - 1]);
        return {
            ...base,
            status: "failed",
            expect: t("mc.releaseRun.fixRetryPreparation"),
            cause:
                fact.state === "lost"
                    ? t("mc.releaseRun.preparationLost")
                    : t("mc.releaseRun.preparationFailed", { words: lastWords(fact) }),
            action: retry,
            log: fact,
            failure: failureOf(at ? stepTitle(at) : PhaseTitles.prepare, fact),
        };
    }
    if (fact?.state === "success") {
        return { ...base, expect: t("mc.releaseRun.stepsDone", { steps: steps.map(stepTitle).join(", ") }) };
    }
    return { ...base, status: "waiting", expect: t("mc.releaseRun.preparationNotRun"), action: retry };
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
        return { ...base, status: "done", expect: t("mc.releaseRun.tagged", { tag }) };
    }
    if (!ready) {
        return { ...base, expect: t("mc.releaseRun.waitsPreparation") };
    }
    if (notesStep && facts.steps[notesStep.id]?.running) {
        return {
            ...base,
            status: "running",
            expect: t("mc.releaseRun.rewritingNotes"),
            log: facts.steps[notesStep.id],
        };
    }
    if (steps.length === 0) {
        return { ...base, status: "waiting", expect: t("mc.releaseRun.cutAtTerminal", { tag }) };
    }
    const phase = stepsPhase(base, steps, facts);
    if (phase == null) {
        const last = steps[steps.length - 1];
        return {
            ...base,
            status: "failed",
            expect: t("mc.releaseRun.cutAgain"),
            cause: t("mc.releaseRun.cutNotOnOrigin", { tag }),
            action: runAgain(last, facts),
        };
    }
    // A manual step is no cut: it is marked done, never read as the step that pushes the tag.
    if (phase.status !== "waiting" || phase.action?.kind !== "step" || phase.manual != null) {
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
    const confirm = declared ?? t("mc.releaseRun.mayPush", { step: action.label, tag });
    return {
        ...phase,
        action: {
            ...action,
            label: declared ? t("mc.releaseRun.cutTag", { tag }) : action.label,
            confirm,
            busy: t("mc.releaseRun.pending.cutting", { tag }),
        },
        expect: facts.notes ? t("mc.releaseRun.readNotes") : t("mc.releaseRun.thenCut", { tag }),
    };
}

function build(facts: ReleaseFacts, tag: string, steps: PipelineReleaseStep[]): Phase {
    const base: Phase = { id: "build", title: PhaseTitles.build, status: "todo", expect: "", links: [] };
    if (!facts.tagexists) {
        return { ...base, expect: t("mc.releaseRun.startsOnTag") };
    }
    if (steps.length > 0) {
        return stepsPhase(base, steps, facts) ?? { ...base, status: "done", expect: t("mc.builds.built") };
    }
    if (facts.nogithub) {
        return { ...base, status: "done", expect: t("mc.releaseRun.noBuildToFollow") };
    }
    const runs = facts.runs ?? [];
    const links = runs.map((r) => ({ label: r.workflowName, url: r.url }));
    if (runs.length === 0) {
        if (facts.release) {
            return { ...base, status: "done", expect: t("mc.releaseRun.noWorkflow") };
        }
        if (facts.githuberror) {
            return { ...base, status: "waiting", expect: t("mc.releaseRun.githubUnread"), cause: facts.githuberror };
        }
        return { ...base, status: "running", expect: t("mc.releaseRun.waitingRun", { tag }) };
    }
    const newest = new Map<string, ReleaseGhRun>();
    for (const run of runs) {
        const known = newest.get(run.workflowName);
        if (!known || run.createdAt > known.createdAt) {
            newest.set(run.workflowName, run);
        }
    }
    const latest = [...newest.values()];
    const approval = (facts.approvals ?? [])[0];
    if (approval != null) {
        return {
            ...base,
            links,
            status: "waiting",
            expect: t("mc.releaseRun.approvalOf", {
                environment: approval.environment,
                workflow: approval.workflow ?? "",
            }),
            approval,
        };
    }
    if (latest.some((r) => r.status !== "completed")) {
        const jobs = facts.jobs ?? [];
        const done = jobs.filter((j) => j.status === "completed").length;
        return {
            ...base,
            links,
            status: "running",
            expect: t("mc.releaseRun.jobsDone", { done, total: jobs.length || "?" }),
        };
    }
    const red = latest.filter((r) => FailedConclusions.has(r.conclusion));
    if (red.length === 0) {
        return { ...base, links, status: "done", expect: t("mc.releaseRun.builtOnGithub") };
    }
    const failedJobs = (facts.jobs ?? []).filter((j) => FailedConclusions.has(j.conclusion)).map((j) => j.name);
    return {
        ...base,
        links,
        status: "failed",
        expect: t("mc.releaseRun.rerunOrFix"),
        cause: failedJobs.length
            ? t("mc.releaseRun.failedJobs", { jobs: failedJobs.join(", ") })
            : t("mc.releaseRun.endedIn", {
                  workflows: red.map((r) => r.workflowName).join(", "),
                  conclusion: red[0].conclusion,
              }),
        action: { kind: "rerun", label: t("mc.remote.rerunFailed"), busy: t("mc.releaseRun.pending.rerunning") },
        failure: {
            step: red.map((r) => r.workflowName).join(", "),
            runs: red.map((r) => ({ name: r.workflowName, runid: r.databaseId, url: r.url })),
        },
    };
}

function publish(facts: ReleaseFacts, channel: ReleaseChannel, steps: PipelineReleaseStep[], built: boolean): Phase {
    const release = facts.release;
    const links = release ? [{ label: t("mc.releaseRun.theRelease"), url: release.url }] : [];
    const base: Phase = { id: "publish", title: PhaseTitles.publish, status: "todo", expect: "", links };
    if (!built) {
        return { ...base, expect: t("mc.releaseRun.waitsBuild") };
    }
    if (!release && steps.length > 0) {
        // Published by the project's own steps, not as a GitHub release.
        return stepsPhase(base, steps, facts) ?? { ...base, status: "done", expect: t("mc.releaseRun.published") };
    }
    if (!release && facts.nogithub) {
        return { ...base, status: "done", expect: t("mc.releaseRun.noPublishToFollow") };
    }
    if (!release) {
        if (facts.githuberror) {
            return { ...base, status: "waiting", expect: t("mc.releaseRun.githubUnread"), cause: facts.githuberror };
        }
        return { ...base, status: "running", expect: t("mc.releaseRun.waitingRelease", { tag: facts.tag }) };
    }
    if (release.isDraft) {
        return {
            ...base,
            status: "waiting",
            expect: channel === "public" ? t("mc.releaseRun.publishDraftPublic") : t("mc.releaseRun.publishDraft"),
        };
    }
    const said = channel === "rc" ? t("mc.releaseRun.publishedRc") : t("mc.releaseRun.publishedPublic");
    const phase = stepsPhase(base, steps, facts);
    if (phase == null) {
        return { ...base, status: "done", expect: said };
    }
    return phase.status === "waiting" ? { ...phase, expect: `${said} ${phase.expect}` } : phase;
}

function back(facts: ReleaseFacts, tag: string, steps: PipelineReleaseStep[], published: boolean): Phase {
    const trunk = facts.trunk || t("mc.builds.theTrunk");
    const links = facts.backpr
        ? [{ label: t("mc.releaseRun.pr", { number: facts.backpr.number }), url: facts.backpr.url }]
        : [];
    const base: Phase = { id: "back", title: PhaseTitles.back, status: "todo", expect: "", links };
    if (facts.tagexists && facts.ontrunk) {
        return { ...base, status: "done", expect: t("mc.releaseRun.backOn", { trunk }) };
    }
    if (!facts.tagexists) {
        return { ...base, expect: t("mc.releaseRun.afterCut") };
    }
    if (facts.backpr) {
        return {
            ...base,
            status: "waiting",
            expect: t("mc.releaseRun.mergePr", { number: facts.backpr.number, trunk }),
        };
    }
    if (steps.length === 0) {
        return {
            ...base,
            status: published ? "waiting" : "todo",
            expect: t("mc.releaseRun.bringBack", { tag, trunk }),
        };
    }
    const phase = stepsPhase(base, steps, facts);
    if (phase == null) {
        return { ...base, status: "waiting", expect: t("mc.releaseRun.waitingReach", { tag, trunk }) };
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
