// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What works with an agent, in a few plain words (FR-AGC-004, #1685): the agent card (first run, the agent's window)
// and the agent picker read the compatibility matrix the same way for every agent. Two groups at a glance, what
// MoltenTerm follows and what the agent can use, then what it cannot yet; each cell's reason on demand. Pure functions:
// the components translate the keys.

import type { TFunction } from "../i18n/i18n";
import { agentFeature, agentRowByProfile, type FeatureLevel, type FeatureMatrix } from "./agent-features-model";

// The features the glance names, by group (keys agentWorks.feature.<id>).
export const FollowedFeatures = ["state", "approvals", "usage"];
export const UsedFeatures = ["browsermcp", "handoff", "guides"];
// The details add what a newcomer meets next: the end-of-turn notice, resuming a session, effort and model, the
// companion and the agent that runs MoltenTerm's own tasks.
export const DetailFeatures = [
    ...FollowedFeatures,
    ...UsedFeatures,
    "turnnotify",
    "resume",
    "effort",
    "companion",
    "runner",
];

// Intl.ListFormat is in every engine MoltenTerm runs on, not yet in the TypeScript library the project targets.
type ListFormatter = { format: (words: string[]) => string };
const ListFormat = (Intl as unknown as { ListFormat: new (locale: string, options: object) => ListFormatter })
    .ListFormat;

// works: native or adapted; partly: MoltenTerm sees it only from the agent's process or terminal; none: not yet.
export type WorksLevel = "works" | "partly" | "none";
export type WorksItem = { feature: string; level: WorksLevel };
export type WorksDetail = WorksItem & { matrixLevel: FeatureLevel; reason?: string };

export type AgentWorks = {
    // The matrix has the agent's row; false shows one sentence instead of the groups.
    known: boolean;
    name: string;
    follows: WorksItem[];
    uses: WorksItem[];
    missing: WorksItem[];
    details: WorksDetail[];
};

function worksLevel(level: FeatureLevel): WorksLevel {
    switch (level) {
        case "native":
        case "adapted":
            return "works";
        case "process-only":
            return "partly";
    }
    return "none";
}

// agent: an agent id ("claude") or a catalog profile id ("claude-code"); the same words for both.
export function agentWorks(matrix: FeatureMatrix, agent: string): AgentWorks {
    const row = agentRowByProfile(matrix, agent);
    if (row == null) {
        return { known: false, name: agent ?? "", follows: [], uses: [], missing: [], details: [] };
    }
    const item = (feature: string): WorksItem => ({
        feature,
        level: worksLevel(agentFeature(matrix, row.id, feature).level),
    });
    const glance = [...FollowedFeatures, ...UsedFeatures].map(item);
    const inGroup = (ids: string[]) => glance.filter((i) => ids.includes(i.feature) && i.level !== "none");
    return {
        known: true,
        name: row.name,
        follows: inGroup(FollowedFeatures),
        uses: inGroup(UsedFeatures),
        missing: glance.filter((i) => i.level === "none"),
        details: DetailFeatures.map((feature) => {
            const cell = agentFeature(matrix, row.id, feature);
            return {
                feature,
                level: worksLevel(cell.level),
                matrixLevel: cell.level,
                reason: cell.level === "native" ? undefined : cell.reason,
            };
        }),
    };
}

// The key of a detail's state: works natively, works through a workaround, partly, not yet.
export function detailLevelKey(d: WorksDetail): string {
    return `agentWorks.level.${d.matrixLevel === "process-only" ? "partly" : d.matrixLevel}`;
}

// The key of a reason in plain words; a reason the interface does not know yet falls back to the generic one.
const ReasonKeys = new Set([
    "noadapter",
    "nohooks",
    "nomcp",
    "noskills",
    "notdetected",
    "agentspecific",
    "modelunverified",
    "provider",
]);

export function reasonKey(reason: string): string {
    return `agentWorks.reason.${ReasonKeys.has(reason) ? reason : "noadapter"}`;
}

// The words of a group, "state (partly), approvals and usage", in the interface language.
export function groupWords(items: WorksItem[], t: TFunction, locale: string): string {
    const words = items.map((i) => {
        const label = t(`agentWorks.feature.${i.feature}`);
        return i.level === "partly" ? t("agentWorks.partly", { feature: label }) : label;
    });
    try {
        return new ListFormat(locale, { style: "long", type: "conjunction" }).format(words);
    } catch {
        return words.join(", ");
    }
}

// The picker's one line: what works, then what does not yet.
export function pickerSummary(works: AgentWorks, t: TFunction, locale: string): string {
    if (!works.known) {
        return t("agentWorks.unknownShort");
    }
    const working = [...works.follows, ...works.uses];
    const parts: string[] = [];
    if (working.length > 0) {
        parts.push(t("agentWorks.picker.works", { features: groupWords(working, t, locale) }));
    }
    if (works.missing.length > 0) {
        parts.push(t("agentWorks.picker.notYet", { features: groupWords(works.missing, t, locale) }));
    }
    return parts.join(" · ");
}
