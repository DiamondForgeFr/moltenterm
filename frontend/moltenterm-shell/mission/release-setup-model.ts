// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release setup (FR-MC-036, DS-MC-030): what wavesrv drafts (pkg/molten/pipelinesetup), the stepper's choices,
// the flow diagram's model and the review's line diff. Pure functions, tested without the app.

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
};

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
};

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
    proposal: SetupProposal;
    current: string;
    base: string;
    proposed: string;
    errors: string[];
    validatewarnings: string[];
};

export type SetupRefined = {
    agent: string;
    agentname: string;
    proposed: string;
    errors: string[];
    validatewarnings: string[];
};

// The setup is offered when the pipeline cannot start one of the two releases.
export function needsReleaseSetup(rcSteps: readonly unknown[], publicSteps: readonly unknown[]): boolean {
    return (rcSteps?.length ?? 0) === 0 || (publicSteps?.length ?? 0) === 0;
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

export type FlowNodeKind = "command" | "manual" | "notes" | "tag" | "workflow" | "dispatch" | "deploy";

export type FlowNode = {
    key: string;
    label: string;
    kind: FlowNodeKind;
    phase: ReleasePhase;
    // The lane it sits on: the trunk, the release branch, or GitHub (the workflows).
    lane: "trunk" | "release" | "github";
    approval?: string;
    source?: SetupSource;
};

export type FlowModel = {
    trunk: string;
    release: string;
    single: boolean;
    nodes: FlowNode[];
    // The trunk reaches the release branch (promote) and comes back (sync-back).
    promote: boolean;
    syncBack: boolean;
};

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
        return { trunk, release: facts.branches.release, single: false, nodes, promote: true, syncBack: false };
    }
    const steps = draft.proposal.release?.[channel] ?? [];
    const phases = phasesOf(steps);
    steps.forEach((step, i) => {
        const key = `${channel}/${step.id}`;
        const dispatch = DispatchRe.exec(step.run ?? "");
        nodes.push({
            key,
            label: step.title || step.id,
            kind: step.manual ? "manual" : step.notes ? "notes" : dispatch ? "dispatch" : "command",
            phase: phases[i],
            lane: dispatch ? "github" : phases[i] === "prepare" && step.id === "promote" ? "trunk" : "release",
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
            lane: "release",
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
    };
}
