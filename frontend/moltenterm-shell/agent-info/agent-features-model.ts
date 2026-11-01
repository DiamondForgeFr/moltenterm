// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The compatibility matrix (FR-AGC-001, DS-AGC-002): how each MoltenTerm feature works with each coding agent, held by
// wavesrv's agent adapters (pkg/molten/agentcontinuity/features.go). The interface reads it here instead of keeping
// its own agent lists (FR-AGC-003, #1684).

import { TabRpcClient } from "@/app/store/wshrpcutil";

// must match pkg/molten/agentcontinuity/featuresroute.go
const RouteId = "molten:agentfeatures";
const GetCommand = "moltenagentfeatures";
const GetTimeoutMs = 8000;

// must match pkg/molten/agentcontinuity/features.go
export type FeatureLevel = "native" | "adapted" | "process-only" | "none";
export type FeatureReason =
    | "noadapter"
    | "nohooks"
    | "nomcp"
    | "noskills"
    | "notdetected"
    | "agentspecific"
    | "modelunverified";
export type FeatureInfo = { id: string; name: string; requires?: string[] };
export type FeatureSupport = {
    level: FeatureLevel;
    reason?: FeatureReason;
    note?: string;
    adapter?: string;
    issue?: string;
};
export type AgentFeatures = { id: string; name: string; adapter: boolean; features: Record<string, FeatureSupport> };
export type FeatureMatrix = { asof: string; features: FeatureInfo[]; agents: AgentFeatures[] };

const Unknown: FeatureSupport = { level: "none", reason: "noadapter" };

export function fetchFeatureMatrix(): Promise<FeatureMatrix> {
    return TabRpcClient.wshRpcCall(GetCommand, null, { route: RouteId, timeout: GetTimeoutMs });
}

// agentFeature is one cell; an agent or a feature the matrix does not know works as none, never as supported.
export function agentFeature(matrix: FeatureMatrix, agent: string, feature: string): FeatureSupport {
    const row = matrix?.agents?.find((a) => a.id === agent);
    return row?.features?.[feature] ?? Unknown;
}

// featureWorks: MoltenTerm can offer the feature with that agent (native or adapted).
export function featureWorks(matrix: FeatureMatrix, agent: string, feature: string): boolean {
    const level = agentFeature(matrix, agent, feature).level;
    return level === "native" || level === "adapted";
}
