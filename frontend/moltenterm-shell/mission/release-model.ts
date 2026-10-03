// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Release menu's numbers and words (FR-MC-015), as Notulia's ReleaseLauncher: the next release candidate of the
// next version, and the next public release, derived from the tags and the commits, or asked for when it is a choice.
// Kept apart from the component so the rules can be tested without the app.

import { PipelineReleaseStep } from "./mission-model";
import { nextRc, parseVersion, ReleaseState } from "./versions";

// must match the channels in pkg/molten/mission/release.go
export type ReleaseChannel = "rc" | "public";

// must match ReleaseSession in pkg/molten/mission/release.go
export type ReleaseSession = { tag: string; version: string; channel: ReleaseChannel; startedat: number };

export type ReleasePlan = {
    rc: string;
    // The next public version: derived, or proposed when it is a decision.
    publicVersion: string;
    publicIsDecision: boolean;
    reason: string;
};

export function isBaseVersion(version: string): boolean {
    try {
        parseVersion(version);
        return true;
    } catch {
        return false;
    }
}

export function releasePlan(state: ReleaseState, tagNames: readonly string[]): ReleasePlan {
    const base = state?.next?.version ?? null;
    return {
        rc: base ? `v${base}-${nextRc(base, tagNames)}` : null,
        publicVersion: base,
        publicIsDecision: state?.next?.how === "decision",
        reason: state?.next?.reason ?? "",
    };
}

// The tag a choice starts; null while the choice is incomplete.
export function releaseChoiceTag(plan: ReleasePlan, choice: ReleaseChannel, version: string): string {
    if (plan == null) {
        return null;
    }
    if (choice === "rc") {
        return plan.rc;
    }
    if (choice === "public" && isBaseVersion(version)) {
        return `v${version}`;
    }
    return null;
}

// The steps that start with the release: the "prepare" phase, or the first step when no phase is declared.
export function preparationSteps(steps: readonly PipelineReleaseStep[]): PipelineReleaseStep[] {
    const list = steps ?? [];
    if (!list.some((s) => s.phase)) {
        return list.slice(0, 1);
    }
    return list.filter((s) => s.phase === "prepare");
}

export function releaseNote(steps: readonly PipelineReleaseStep[]): string {
    const prepare = preparationSteps(steps).map((s) => s.title || s.id);
    const start = prepare.length
        ? `The preparation starts right away: ${prepare.join(", ")}.`
        : "Nothing runs right away: the pipeline declares no preparation.";
    return `${start} Each next step will wait for your click on the Timeline.`;
}
