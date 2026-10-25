// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release setup (FR-MC-036, DS-MC-030): what wavesrv drafts (pkg/molten/pipelinesetup), the stepper's choices,
// the flow diagram's model and the review's line diff. Pure functions, tested without the app.

import type { TFunction } from "../i18n/i18n";
import type { PipelineReleaseStep, ReleasePhase } from "./mission-model";

export type SetupKind = "on-premise" | "saas";
export type SetupChannel = "rc" | "public";

// must match Source in pkg/molten/pipelinesetup/detect.go
export type SetupSource = { code: string; path?: string; detail?: string };

export type SetupWorkflow = {
    file: string;
    name?: string;
    push: boolean;
    tags?: string[];
    branches?: string[];
    pullrequest?: boolean;
    dispatch: boolean;
    inputs?: string[];
    requiredinputs?: string[];
    environments?: string[];
    role: "ci" | "publish" | "deploy" | "docs" | "other";
    ships?: string[];
};

export type SetupTarget = { id: string; packager: string; source: SetupSource };

export type SetupFacts = {
    name: string;
    haspipeline: boolean;
    missing: SetupChannel[];
    branches: { trunk: string; release: string; trunkfrom?: string; releasefrom?: string };
    rcbranchpattern?: string;
    tagprefix: string;
    versionsdeclared: boolean;
    versionsource: SetupSource;
    notesdeclared: boolean;
    notespath: string;
    notesfound: boolean;
    changelogs: { path: string; lang: string }[];
    workflows: SetupWorkflow[];
    targets: SetupTarget[];
    ongithub: boolean;
    kind: SetupKind;
    kindevidence: SetupSource[];
    saasfoundry: boolean;
    ticketbranches: boolean;
    currentbranch?: string;
    releaseworktree: string;
    committicket?: boolean;
    currentversion?: string;
    labels: SetupLabel[];
    protection?: SetupProtection;
    divergence?: SetupDivergence;
};

// must match VersionLabel in pkg/molten/pipelinesetup/labels.go
export type SetupLabel = { path: string; line: number; text: string; version: string; pattern: string };
export type SetupLabelChoice = { path: string; line: number; pattern?: string };

// must match Protection in pkg/molten/pipelinesetup/remote.go
export type SetupProtection = {
    branch: string;
    read: boolean;
    error?: string;
    pullrequest: boolean;
    requiredchecks: string[];
    strict: boolean;
    noforcepush: boolean;
    restrictupdates: boolean;
    mergemethods: string[];
    bypass?: "always" | "pull_requests_only" | "never" | "";
    sources: SetupSource[];
};

// must match Divergence in pkg/molten/pipelinesetup/remote.go
export type SetupDivergence = {
    trunk: string;
    release: string;
    read: boolean;
    ahead: number;
    behind: number;
    conflicts: boolean;
    conflictfiles: number;
    notequivalent: number;
    samples: string[];
};

// must match Protection.RequiresPr in pkg/molten/pipelinesetup/remote.go
export function requiresPr(p: SetupProtection): boolean {
    if (p == null || !p.read) {
        return false;
    }
    return (p.pullrequest || (p.requiredchecks?.length ?? 0) > 0 || p.restrictupdates) && p.bypass !== "always";
}

export function diverged(d: SetupDivergence): boolean {
    return d != null && d.read && d.ahead > 0 && d.behind > 0;
}

// must match Divergence.Reconcilable in pkg/molten/pipelinesetup/remote.go
export function reconcilable(d: SetupDivergence): boolean {
    return diverged(d) && d.conflicts && d.notequivalent === 0;
}

export function labelKept(options: SetupOptions, label: SetupLabel): boolean {
    return (options.labels ?? []).some((l) => l.path === label.path && l.line === label.line);
}

export function toggledLabel(options: SetupOptions, label: SetupLabel, on: boolean): SetupOptions {
    const rest = (options.labels ?? []).filter((l) => !(l.path === label.path && l.line === label.line));
    const labels = on ? [...rest, { path: label.path, line: label.line, pattern: label.pattern }] : rest;
    return { ...options, labels };
}

// The RC branch as the pipeline's text names it (pkg/molten/pipelinesetup rcBranchDisplay).
export function rcBranchDisplay(facts: SetupFacts): string {
    const pattern = facts.rcbranchpattern?.includes("{version}") ? facts.rcbranchpattern : "rc-{version}";
    return pattern.split("{version}").join("X.Y.Z");
}

export type ManualStep = { id: string; title: string; text: string; channel?: SetupChannel | ""; before?: string };

// must match Options in pkg/molten/pipelinesetup/template.go
export type SetupOptions = {
    kind: SetupKind;
    channels: SetupChannel[];
    branchmodel: string;
    merge: string;
    tagprefix: string;
    rcformat: string;
    changelogs: string[];
    ciworkflows: string[];
    dispatch: { workflow: string; channel?: string }[];
    notes: boolean;
    notespath: string;
    syncback: boolean;
    milestone: boolean;
    manual: ManualStep[];
    environments: string[];
    reconcile: boolean;
    labels: SetupLabelChoice[];
    // Step 2b's description (FR-MC-041), unset on the other paths.
    trunk?: string;
    release?: string;
    rc?: SetupRcAnswer;
    publish?: string[];
};

// must match Rc* in pkg/molten/pipelinesetup/describe.go
export type SetupRcAnswer = "none" | "published" | "internal";

// must match ProposedFile in pkg/molten/pipelinesetup/describe.go: a new workflow beside the pipeline (FR-MC-041).
export type SetupProposedFile = { path: string; content: string; targets: string[] };

export type SetupChoice = {
    id: string;
    allowed: boolean;
    reasons?: { code: string; target?: string; refuses: boolean }[];
};

export type SetupAdapterStep = { id: string; title: string; section: string; environment?: string; run?: string };

export type SetupProposal = {
    release?: { rc?: PipelineReleaseStep[]; public?: PipelineReleaseStep[] };
    steps?: SetupAdapterStep[];
    sources: Record<string, SetupSource>;
};

export type SetupDeployTarget = { environment: string; workflow: string; dispatch: boolean };
export type SetupTagWorkflow = { file: string; name?: string; environments: string[] };

// must match DraftAnswer in pkg/molten/pipelinesetup/setup.go
export type SetupDraft = {
    provider: "moltenterm" | "saasfoundry";
    warnings: string[];
    facts: SetupFacts;
    defaults: SetupOptions;
    options: SetupOptions;
    rcformats: SetupChoice[];
    branchmodels: SetupChoice[];
    merges: SetupChoice[];
    deploytargets: SetupDeployTarget[];
    tagworkflows: Record<SetupChannel, SetupTagWorkflow[]>;
    // The CI workflows each channel's tag starts too (#1101).
    tagci?: Record<SetupChannel, string[]>;
    proposal: SetupProposal;
    current: string;
    base: string;
    proposed: string;
    errors: string[];
    validatewarnings: string[];
    generated?: Record<string, string>;
    files?: SetupProposedFile[];
    branchnames?: string[];
    pr: SetupPrPlan;
};

// must match PrPlan, PrStep, PrFailure, PrJob and Ticket in pkg/molten/pipelinesetup/pullrequest.go (#1098)
export type SetupPrPlan = {
    git: boolean;
    ref: string;
    commit: string;
    target: string;
    ongithub: boolean;
    ticketrequired: boolean;
    branch: string;
    subject: string;
    tickettitle: string;
    uncommitted: boolean;
    conflict?: boolean;
    included: boolean;
    localbase: string;
    local?: string;
};
export type SetupPrStepId = "ticket" | "worktree" | "write" | "commit" | "push" | "pr" | "patch";
export type SetupPrStep = {
    id: SetupPrStepId;
    state: "pending" | "running" | "done" | "failed" | "skipped";
    info?: string;
};
export type SetupPrFailure = { code: string; output?: string; commit?: string };
export type SetupPrJob = {
    id: string;
    dir: string;
    kind: "write" | "update";
    mode: "pr" | "patch";
    steps: SetupPrStep[];
    finished: boolean;
    failure?: SetupPrFailure;
    ref: string;
    target: string;
    ongithub: boolean;
    branch?: string;
    subject?: string;
    ticket?: number;
    commit?: string;
    prurl?: string;
    prnumber?: number;
    patch?: string;
    files: string[];
};
export type SetupTicket = { number: number; title: string };

// The developer's ticket for the setup's commit: an open issue, or one MoltenTerm creates.
export type SetupTicketChoice = { ticket: number; create: boolean; title: string };

// The fields of Write's and Update's requests that open the pull request.
export type SetupPrRequest = {
    includelocal?: boolean;
    localbase?: string;
    ticket?: number;
    createticket?: boolean;
    newticket?: string;
    mode: "pr" | "patch";
};

export function prRequestOf(plan: SetupPrPlan, choice: SetupTicketChoice, mode: "pr" | "patch"): SetupPrRequest {
    const req: SetupPrRequest = { mode };
    if (plan.included) {
        req.includelocal = true;
        req.localbase = plan.localbase;
    }
    if (!plan.ticketrequired) {
        return req;
    }
    if (choice.ticket > 0) {
        req.ticket = choice.ticket;
    } else if (choice.create && mode === "pr") {
        req.createticket = true;
        req.newticket = choice.title.trim() || plan.tickettitle;
    }
    return req;
}

// The plan's names with the chosen ticket ({N} stays while MoltenTerm will create it).
export function prNamesOf(plan: SetupPrPlan, ticket: number): { branch: string; subject: string } {
    if (!(ticket > 0)) {
        return { branch: plan.branch, subject: plan.subject };
    }
    const n = String(ticket);
    return { branch: plan.branch.split("{N}").join(n), subject: plan.subject.split("{N}").join(n) };
}

// The pull request can be asked for: a git repository, and a ticket when the commit format names one.
export function canOpenPr(plan: SetupPrPlan, choice: SetupTicketChoice, mode: "pr" | "patch"): boolean {
    if (plan == null || !plan.git) {
        return false;
    }
    if (!plan.ticketrequired || mode === "patch") {
        return true;
    }
    return choice.ticket > 0 || choice.create;
}

// must match Change, UpdateReason and CheckAnswer in pkg/molten/pipelinesetup/update.go (#1086)
export type SetupChangeKind = "added" | "removed" | "changed" | "versions";
export type SetupChange = {
    key: string;
    channel?: SetupChannel;
    id?: string;
    kind: SetupChangeKind;
    title?: string;
    before?: string;
    after?: string;
    customised: boolean;
    take: boolean;
};
export type SetupUpdateReason = { code: "protected" | "labels" | "template" | "customised"; detail?: string };
export type SetupCheck = {
    state: "missing" | "update" | "uptodate";
    reasons: SetupUpdateReason[];
    changes: SetupChange[];
    recordtemplate: number;
    template: number;
    releasebranch: string;
    current: string;
    base: string;
    proposed: string;
    signature: string;
    errors: string[];
    validatewarnings: string[];
    pr: SetupPrPlan;
};

// A change is applied when the developer ticked it, else by its default (a customised step is kept).
export function changeTaken(change: SetupChange, choices: Record<string, boolean>): boolean {
    const choice = choices?.[change.key];
    return choice == null ? change.take : choice;
}

// The changes by where they go: the release candidate's steps, the public release's, then the version files.
export function changeGroups(
    changes: readonly SetupChange[]
): { group: SetupChannel | "versions"; changes: SetupChange[] }[] {
    const groups: { group: SetupChannel | "versions"; changes: SetupChange[] }[] = [];
    for (const group of ["rc", "public", "versions"] as const) {
        const list = (changes ?? []).filter((c) =>
            group === "versions" ? c.kind === "versions" : c.channel === group
        );
        if (list.length > 0) {
            groups.push({ group, changes: list });
        }
    }
    return groups;
}

// must match pkg/molten/pipelinesetup/proposal.go
export type SetupStepChangeOp = "add" | "change" | "remove" | "versions";

// One change the agent proposes (#1099), as MoltenTerm checked it; sent back as is to setupApply, which checks it again.
export type SetupStepChange = {
    key: string;
    op: SetupStepChangeOp;
    channel?: SetupChannel;
    id?: string;
    after?: string;
    before?: string;
    step?: Record<string, unknown>;
    versions?: Record<string, unknown>;
    why?: string;
    title?: string;
    oldtext?: string;
    newtext?: string;
};

// A proposed change MoltenTerm does not offer, with its reason (mc.setup.proposal.rejected.<code>).
export type SetupRejectedChange = {
    text: string;
    code: string;
    detail?: string;
};

export type SetupApplied = {
    proposed: string;
    errors: string[];
    validatewarnings: string[];
};

export type SetupRefined = SetupApplied & {
    // Empty for an answer pasted from another agent.
    agent: string;
    agentname: string;
    changes: SetupStepChange[];
    rejected: SetupRejectedChange[];
};

// What the review shows once a proposal is in: the draft with the ticked changes, and who proposed them.
export type SetupProposalResult = SetupApplied & {
    agentname: string;
};

// The setup is offered when the pipeline cannot start one of the two releases.
export function needsReleaseSetup(rcSteps: readonly unknown[], publicSteps: readonly unknown[]): boolean {
    return (rcSteps?.length ?? 0) === 0 || (publicSteps?.length ?? 0) === 0;
}

export function setupReasonText(t: TFunction, reason: SetupUpdateReason): string {
    return t(`mc.setup.update.reason.${reason.code}`, { branch: reason.detail ?? "", count: reason.detail ?? "" });
}

export function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
    const rest = (list ?? []).filter((x) => x !== item);
    return on ? [...rest, item] : rest;
}

const TagPrefixRe = /^[A-Za-z][A-Za-z0-9._/-]*$/;

export function validTagPrefix(prefix: string): boolean {
    return TagPrefixRe.test(prefix ?? "");
}

export function stepIdOf(title: string): string {
    const id = (title ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-._]+|[-._]+$/g, "");
    return id || "manual";
}

// addManual gives the new step an id no other step of its channels uses.
export function addManual(options: SetupOptions, step: Omit<ManualStep, "id">, taken: readonly string[]): SetupOptions {
    const used = new Set([...(taken ?? []), ...(options.manual ?? []).map((m) => m.id)]);
    const base = stepIdOf(step.title);
    let id = base;
    for (let n = 2; used.has(id); n++) {
        id = `${base}-${n}`;
    }
    return { ...options, manual: [...(options.manual ?? []), { ...step, id }] };
}

export function removeManual(options: SetupOptions, id: string): SetupOptions {
    return { ...options, manual: (options.manual ?? []).filter((m) => m.id !== id) };
}

// --- Line diff of the review -------------------------------------------------------------------------------------

export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

const MaxDiffCells = 4_000_000;

// lineDiff: the longest common subsequence of the lines; a very large pair falls back to everything replaced.
export function lineDiff(before: string, after: string): DiffLine[] {
    const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
    const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
    const rows: DiffLine[] = [];
    if (a.length * b.length > MaxDiffCells) {
        a.forEach((text, i) => rows.push({ kind: "del", text, oldNo: i + 1 }));
        b.forEach((text, j) => rows.push({ kind: "add", text, newNo: j + 1 }));
        return rows;
    }
    const n = a.length;
    const m = b.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            rows.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: j + 1 });
            i++;
            j++;
        } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
            rows.push({ kind: "add", text: b[j], newNo: j + 1 });
            j++;
        } else {
            rows.push({ kind: "del", text: a[i], oldNo: i + 1 });
            i++;
        }
    }
    return rows;
}

// Hunks: the changed lines with this much context; the rest folds into a count.
export function diffHunks(rows: DiffLine[], context = 3): (DiffLine | { kind: "fold"; count: number })[] {
    const keep = new Array<boolean>(rows.length).fill(false);
    rows.forEach((row, i) => {
        if (row.kind === "same") {
            return;
        }
        for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
            keep[k] = true;
        }
    });
    const out: (DiffLine | { kind: "fold"; count: number })[] = [];
    let folded = 0;
    rows.forEach((row, i) => {
        if (keep[i]) {
            if (folded > 0) {
                out.push({ kind: "fold", count: folded });
                folded = 0;
            }
            out.push(row);
            return;
        }
        folded++;
    });
    if (folded > 0) {
        out.push({ kind: "fold", count: folded });
    }
    return out;
}

// --- Flow diagram ------------------------------------------------------------------------------------------------

export const FlowPhases: ReleasePhase[] = ["prepare", "cut", "build", "publish", "back"];

// "pr" and "target" draw the existing pipeline (#1101): a pull request, and where a release is published to.
export type FlowNodeKind =
    | "command"
    | "manual"
    | "notes"
    | "tag"
    | "workflow"
    | "dispatch"
    | "deploy"
    | "pr"
    | "target";

export type FlowNode = {
    key: string;
    label: string;
    kind: FlowNodeKind;
    phase: ReleasePhase;
    // The lane it sits on: the trunk, the RC branch of the pull-request flow, the release branch, GitHub (the
    // workflows), or what the release is published to.
    lane: "trunk" | "rc" | "release" | "github" | "targets";
    approval?: string;
    source?: SetupSource;
    // Step 2a (#1101): the point of "What we understood" it belongs to, the point's number on its first node (a
    // question while it is to confirm), a step run only when needed, and a pull request's required checks.
    point?: string;
    badge?: number;
    question?: boolean;
    conditional?: boolean;
    checks?: string;
};

export type FlowModel = {
    trunk: string;
    release: string;
    single: boolean;
    nodes: FlowNode[];
    // The trunk reaches the release branch (promote) and comes back (sync-back).
    promote: boolean;
    syncBack: boolean;
    // The pull-request flow (#1046): the RC branch leaves the trunk and is merged into the release branch.
    viaPr: boolean;
    rcBranch?: string;
};

// The steps of the pull-request flow that run on the RC branch, before its pull request is merged.
const RcLaneSteps = new Set(["prepare", "reconcile", "bump-labels", "open-pr"]);

const DispatchRe = /^molten release dispatch\s+(\S+)/;

// The phase each step runs in, as the backend reads it (pkg/molten/pipeline.go ReleaseStepPhase).
function phasesOf(steps: readonly PipelineReleaseStep[]): ReleasePhase[] {
    const phased = steps.some((s) => s.phase && !s.notes);
    let current: ReleasePhase = "prepare";
    return steps.map((s, i) => {
        if (s.notes) {
            return "cut";
        }
        if (!phased) {
            return i === 0 ? "prepare" : "cut";
        }
        if (s.phase) {
            current = s.phase;
        }
        return current;
    });
}

// flowModel lays one channel's proposal out: its steps in their phases, the tag, the workflows the tag starts and the
// environments that ask for an approval; for a SaaS, the deploy steps one per environment.
export function flowModel(draft: SetupDraft, channel: SetupChannel, prefix: string): FlowModel {
    const facts = draft.facts;
    const trunk = facts.branches.trunk;
    const kind = draft.options.kind;
    const single = draft.options.branchmodel === "single" || trunk === facts.branches.release;
    const release = single ? trunk : facts.branches.release;
    const nodes: FlowNode[] = [];
    if (kind === "saas") {
        for (const step of draft.proposal.steps ?? []) {
            if (step.section !== "cd" || !step.environment) {
                continue;
            }
            nodes.push({
                key: `steps/${step.id}`,
                label: step.environment,
                kind: "deploy",
                phase: "publish",
                lane: "github",
                source: draft.proposal.sources?.[`steps/${step.id}`],
            });
        }
        return {
            trunk,
            release: facts.branches.release,
            single: false,
            nodes,
            promote: true,
            syncBack: false,
            viaPr: false,
        };
    }
    const steps = draft.proposal.release?.[channel] ?? [];
    const phases = phasesOf(steps);
    const viaPr = steps.some((s) => (s.run ?? "").startsWith("molten release open-pr"));
    // A candidate tagged on its RC branch never reaches the release branch (#1046).
    const onRcBranch = steps.some((s) => /^molten release tag .*--rc-branch/.test(s.run ?? ""));
    const laneOf = (step: PipelineReleaseStep, i: number): FlowNode["lane"] => {
        if (phases[i] === "prepare" && step.id === "promote") {
            return "trunk";
        }
        if (onRcBranch && phases[i] !== "back") {
            return "rc";
        }
        if (viaPr && phases[i] !== "back" && (RcLaneSteps.has(step.id) || step.manual || step.notes)) {
            return "rc";
        }
        return "release";
    };
    steps.forEach((step, i) => {
        const key = `${channel}/${step.id}`;
        const dispatch = DispatchRe.exec(step.run ?? "");
        nodes.push({
            key,
            label: step.title || step.id,
            kind: step.manual ? "manual" : step.notes ? "notes" : dispatch ? "dispatch" : "command",
            phase: phases[i],
            lane: dispatch ? "github" : laneOf(step, i),
            approval: dispatch
                ? (facts.workflows.find((w) => w.file === dispatch[1])?.environments ?? []).join(", ") || undefined
                : undefined,
            source: draft.proposal.sources?.[key],
        });
    });
    if (steps.length > 0) {
        nodes.push({
            key: `${channel}/@tag`,
            label: channel === "rc" ? `${prefix}X.Y.Z-N` : `${prefix}X.Y.Z`,
            kind: "tag",
            phase: "cut",
            lane: onRcBranch ? "rc" : "release",
        });
        for (const wf of draft.tagworkflows?.[channel] ?? []) {
            nodes.push({
                key: `${channel}/@wf/${wf.file}`,
                label: wf.name || wf.file,
                kind: "workflow",
                phase: "build",
                lane: "github",
                approval: wf.environments.join(", ") || undefined,
            });
        }
    }
    return {
        trunk,
        release,
        single,
        nodes,
        promote: steps.some((s) => s.id === "promote"),
        syncBack: steps.some((s) => s.id === "sync-back"),
        viaPr: viaPr || onRcBranch,
        rcBranch: viaPr || onRcBranch ? rcBranchDisplay(facts) : undefined,
    };
}
