// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project header's Deploy to shortcut (#559): the environments a project's cd steps deploy to, which of them ask
// before running, and what a deploy takes (the branch checked out in the project, where every step runs).

import { MissionGit, PipelineAdapterStep, PipelineDef, RunRecord } from "./mission-model";

const ProductionWords = new Set(["prod", "production", "live"]);

export type DeployTarget = {
    environment: string;
    stepId: string;
    title: string;
    confirm: boolean;
    last: RunRecord;
};

// A word of the name, so `prod-eu` asks and `preprod` does not.
export function isProductionLike(environment: string): boolean {
    return (environment ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((word) => ProductionWords.has(word));
}

export function stepLastRun(runs: readonly RunRecord[], stepId: string): RunRecord {
    return (runs ?? []).find((r) => r.kind === "step" && r.stepid === stepId) ?? null;
}

export function deployTarget(step: PipelineAdapterStep, runs: readonly RunRecord[]): DeployTarget {
    const environment = step.environment ?? "";
    return {
        environment,
        stepId: step.id,
        title: step.title || step.id,
        confirm: environment !== "" && (step.confirm === true || isProductionLike(environment)),
        last: stepLastRun(runs, step.id),
    };
}

// In the order the pipeline declares them; empty when no cd step names an environment.
export function deployTargets(pipeline: PipelineDef, runs: readonly RunRecord[]): DeployTarget[] {
    return (pipeline?.steps ?? []).filter((s) => s.section === "cd" && s.environment).map((s) => deployTarget(s, runs));
}

export type DeployRevision = { branch: string; commit: string };

export function deployRevision(git: MissionGit): DeployRevision {
    const branch = git?.current ?? "";
    const sha = (git?.branches ?? []).find((b) => b.name === branch)?.sha ?? "";
    return { branch, commit: sha.slice(0, 7) };
}

export function revisionText(revision: DeployRevision): string {
    if (!revision.branch) {
        return "the commit checked out in the project (no branch)";
    }
    return revision.commit ? `${revision.branch} at ${revision.commit}` : revision.branch;
}

// One step runs at a time (the CD tab's rule): any step under way holds the others.
export function stepRunning(runs: readonly RunRecord[]): boolean {
    return (runs ?? []).some((r) => r.kind === "step" && r.state === "running");
}
