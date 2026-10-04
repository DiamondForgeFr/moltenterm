// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Release menu's numbers and words (FR-MC-015), as Notulia's ReleaseLauncher: the next release candidate of the
// next version, and the next public release, derived from the tags and the commits, or asked for when it is a choice.
// Kept apart from the component so the rules can be tested without the app.

import { DefaultTagPrefix, nextRc, parseBase, planRelease, tagOf, VersionRules } from "../releases/versions";
import { PipelineReleaseStep } from "./mission-model";
import { ReleaseState } from "./versions";

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
    // The project's tag prefix (versions.tagprefix).
    prefix: string;
    // The rules and tags an explicit version is checked against.
    rules: VersionRules;
    tags: readonly string[];
};

export function releasePlan(state: ReleaseState, tagNames: readonly string[], rules: VersionRules = {}): ReleasePlan {
    const base = parseBase(state?.next?.version ?? "");
    return {
        rc: base ? tagOf(rules, { ...base, rc: nextRc(rules, base, tagNames) }) : null,
        publicVersion: state?.next?.version ?? null,
        publicIsDecision: state?.next?.how === "decision",
        reason: state?.next?.reason ?? "",
        prefix: rules.tagprefix || DefaultTagPrefix,
        rules,
        tags: tagNames,
    };
}

// The tag a choice starts; null while the choice is incomplete, or when the number typed for the first public
// release is not one the project can release (below versions.firstpublic, or already tagged).
export function releaseChoiceTag(plan: ReleasePlan, choice: ReleaseChannel, version: string): string {
    if (plan == null) {
        return null;
    }
    if (choice === "rc") {
        return plan.rc;
    }
    if (choice !== "public" || !version) {
        return null;
    }
    const chosen = planRelease(plan.rules, plan.tags, [], "public", version);
    return chosen.how === "refused" ? null : chosen.tag;
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
