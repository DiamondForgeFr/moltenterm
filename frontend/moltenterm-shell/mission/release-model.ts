// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Release menu's numbers and words (FR-MC-015), as Notulia's ReleaseLauncher: the next release candidate of the
// next version, and the next public release, derived from the tags and the commits, or asked for when it is a choice.
// Kept apart from the component so the rules can be tested without the app.

import { t } from "../i18n/i18n";
import {
    DefaultTagPrefix,
    formatVersion,
    nextCandidate,
    parseBase,
    planRelease,
    releaseOf,
    tagOf,
    VersionRules,
} from "../releases/versions";
import { PipelineReleaseStep, ReleasePhase } from "./mission-model";
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
    // The bump the commits call for (major, minor, patch); empty for a decision.
    level?: string;
    // The project's tag prefix (versions.tagprefix).
    prefix: string;
    // The rules and tags an explicit version is checked against.
    rules: VersionRules;
    tags: readonly string[];
};

export function releasePlan(state: ReleaseState, tagNames: readonly string[], rules: VersionRules = {}): ReleasePlan {
    const base = parseBase(state?.next?.version ?? "");
    return {
        rc: base ? tagOf(rules, nextCandidate(rules, base, tagNames)) : null,
        publicVersion: state?.next?.version ?? null,
        publicIsDecision: state?.next?.how === "decision",
        reason: state?.next?.reason ?? "",
        level: state?.next?.level ?? "",
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

// What the Release menu needs of the Project header's next station (NextStation in ../project/next-station-model.ts).
export type StationOffer = { tag: string; milestonefirst?: boolean; bigger?: boolean };

export type PlannedRelease = {
    // "1.1.1"
    version: string;
    // "v1.1.1"
    tag: string;
    // "v1.1.1-1"; null when the candidates of that version are used up.
    rc: string;
    // Why the station's number is not offered (its tag is cut); null when it is.
    refused: string;
    // The commits call for a bigger bump than the station's number: starting it is confirmed once.
    confirm: boolean;
};

// The planned next version the menu offers first (#2268): the station when it is a milestone's number other than the
// computed one. Null, and the menu as before, when the station is the computed number, without a dated milestone, for
// a first public release and when nothing is to release.
export function plannedRelease(plan: ReleasePlan, station: StationOffer): PlannedRelease {
    if (plan == null || plan.publicIsDecision || !plan.publicVersion || !station?.milestonefirst || !station.tag) {
        return null;
    }
    const version = releaseBaseOf(plan.rules, station.tag);
    if (!version || version === plan.publicVersion) {
        return null;
    }
    const tag = tagOf(plan.rules, parseBase(version));
    if (plan.tags.some((name) => name.trim() === tag)) {
        return { version, tag, rc: null, refused: t("mc.releaseMenu.plannedTagged", { tag }), confirm: false };
    }
    const chosen = planRelease(plan.rules, plan.tags, [], "public", version);
    if (chosen.how === "refused") {
        return null;
    }
    const candidate = planRelease(plan.rules, plan.tags, [], "rc", version);
    return {
        version,
        tag,
        rc: candidate.how === "refused" ? null : candidate.tag,
        refused: null,
        confirm: !!station.bigger,
    };
}

function levelWord(level: string): string {
    return level ? t(`project.station.levels.${level}`) : "";
}

// Why the computed number is what it is, under the planned one (#2268).
export function computedReasonText(plan: ReleasePlan): string {
    const vars = { tag: plan.prefix + plan.publicVersion, level: levelWord(plan.level), reason: plan.reason };
    return plan.reason ? t("mc.releaseMenu.computedReason", vars) : t("mc.releaseMenu.computedReasonPlain", vars);
}

// The one confirmation before a planned number smaller than the commits call for (#2268).
export function plannedConfirmText(plan: ReleasePlan, tag: string): string {
    const vars = {
        tag,
        derived: plan.prefix + plan.publicVersion,
        level: levelWord(plan.level),
        reason: plan.reason,
    };
    return plan.reason ? t("mc.releaseMenu.plannedConfirm", vars) : t("mc.releaseMenu.plannedConfirmPlain", vars);
}

// must match Milestone in pkg/molten/release/milestone.go
export type ReleaseMilestone = {
    number: number;
    title: string;
    url: string;
    opencount: number;
    issues: { number: number; title: string; url: string }[];
};

export const MaxListedMilestoneIssues = 6;

// The public version a release tag leads to ("v1.0.0-3" → "1.0.0"), or null for a tag that is not a release.
export function releaseBaseOf(rules: VersionRules, tag: string): string {
    const v = tag ? releaseOf(rules, tag) : null;
    return v ? formatVersion({ ...v, rc: 0 }) : null;
}

export type MilestoneWarning = {
    text: string;
    // Open issues are a warning, never a refusal: a milestone reports, it does not block (FR-REL-002).
    warn: boolean;
    issues: ReleaseMilestone["issues"];
    more: number;
};

export function milestoneWarning(version: string, milestone: ReleaseMilestone): MilestoneWarning {
    if (milestone == null) {
        return { text: t("mc.releaseMenu.noMilestone", { version }), warn: false, issues: [], more: 0 };
    }
    const issues = milestone.issues ?? [];
    if (issues.length === 0) {
        return {
            text: t("mc.releaseMenu.milestoneClear", { title: milestone.title }),
            warn: false,
            issues: [],
            more: 0,
        };
    }
    const count =
        issues.length === 1 ? t("mc.releaseMenu.openIssue") : t("mc.releaseMenu.openIssues", { count: issues.length });
    return {
        text: t("mc.releaseMenu.milestoneOpen", { title: milestone.title, count }),
        warn: true,
        issues: issues.slice(0, MaxListedMilestoneIssues),
        more: Math.max(0, issues.length - MaxListedMilestoneIssues),
    };
}

// must match ReleaseStepPhase in pkg/molten/pipeline.go: each step's phase as declared, or, in a list that declares
// phases, the phase of the step before it (the first: prepare). Without any declared phase the first step prepares and
// the others get null, their phase being known only as the release goes. Steps that rewrite the notes get none.
export function releaseStepPhases(steps: readonly PipelineReleaseStep[]): ReleasePhase[] {
    const list = steps ?? [];
    const phased = list.some((s) => s.phase && !s.notes);
    let current: ReleasePhase = "prepare";
    let first = true;
    return list.map((step) => {
        if (step.notes) {
            return null;
        }
        const wasFirst = first;
        first = false;
        if (!phased) {
            return wasFirst ? "prepare" : null;
        }
        current = step.phase || current;
        return current;
    });
}

// The steps that start with the release: the "prepare" phase, or the first step when no phase is declared.
export function preparationSteps(steps: readonly PipelineReleaseStep[]): PipelineReleaseStep[] {
    const phases = releaseStepPhases(steps);
    return (steps ?? []).filter((_, i) => phases[i] === "prepare");
}

export function releaseNote(steps: readonly PipelineReleaseStep[]): string {
    const prepare = preparationSteps(steps).map((s) => s.title || s.id);
    const start = prepare.length
        ? t("mc.releaseMenu.prepareNow", { steps: prepare.join(", ") })
        : t("mc.releaseMenu.prepareNone");
    return t("mc.releaseMenu.note", { start });
}
