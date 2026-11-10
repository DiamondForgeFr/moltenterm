// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How much each agent has been tried with MoltenTerm (FR-AGC-001, FR-AGC-004, #2167): a level the registry in wavesrv
// holds by hand (pkg/molten/agentcontinuity/features.go, TriedLevels) and the compatibility matrix serves with its own
// date. The cards, the agent's "what works" view and Help me choose say it in the same words. Pure functions: the
// components translate the keys. The level is information about testing, never a ranking.

import { MoltentermRepoUrl } from "@/util/moltenterm-identity";
import { agentRowByProfile, type FeatureMatrix } from "./agent-features-model";

// must match pkg/molten/agentcontinuity/features.go
export type TriedLevel = "daily" | "tested" | "little";
export const TriedLevels: TriedLevel[] = ["daily", "tested", "little"];

export type AgentTried = { level: TriedLevel; asof: string };

export const ReportIssueUrl = `${MoltentermRepoUrl}/issues/new`;

// The agent, by agent id ("claude") or catalog profile id ("claude-code"); null when the matrix does not know the
// agent or gives it no valid level (the interface then says nothing rather than guess).
export function agentTried(matrix: FeatureMatrix, agent: string): AgentTried {
    const level = agentRowByProfile(matrix, agent)?.tried as TriedLevel;
    if (!TriedLevels.includes(level)) {
        return null;
    }
    return { level, asof: matrix?.triedasof ?? "" };
}

// The repository's new-issue page with the agent's name in the title. The title is for the repository's maintainers,
// so it stays English whatever the interface language is.
export function reportProblemUrl(agentName: string): string {
    const name = (agentName ?? "").trim();
    if (name === "") {
        return ReportIssueUrl;
    }
    return `${ReportIssueUrl}?title=${encodeURIComponent(`[${name}] `)}`;
}

export function triedLevelKey(level: TriedLevel): string {
    return `agentTried.level.${level}`;
}

export function triedMeaningKey(level: TriedLevel): string {
    return `agentTried.meaning.${level}`;
}
