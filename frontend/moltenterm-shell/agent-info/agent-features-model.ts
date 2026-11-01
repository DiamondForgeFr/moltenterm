// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The compatibility matrix (FR-AGC-001, DS-AGC-002): how each MoltenTerm feature works with each coding agent, held by
// wavesrv's agent adapters (pkg/molten/agentcontinuity/features.go). The interface reads it here instead of keeping
// its own agent lists (FR-AGC-003, #1684): which agents a surface offers an action to, their names and how they call
// a guide. An agent the matrix does not know, or a matrix not read yet, offers nothing.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";

// must match pkg/molten/agentcontinuity/featuresroute.go
const RouteId = "molten:agentfeatures";
const GetCommand = "moltenagentfeatures";
const GetTimeoutMs = 8000;
const RetryMs = 5000;

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
// profile: the agent's guide and catalog profile id ("claude-code"); guidecall: how it calls a guide, {name} the
// guide's name ("${name}").
export type AgentFeatures = {
    id: string;
    name: string;
    adapter: boolean;
    profile?: string;
    guidecall?: string;
    features: Record<string, FeatureSupport>;
};
export type FeatureMatrix = { asof: string; features: FeatureInfo[]; agents: AgentFeatures[] };

const Unknown: FeatureSupport = { level: "none", reason: "noadapter" };
// The call of an agent whose row gives none: the slash command most agents use.
const DefaultGuideCall = "/{name}";

// The RPC client is loaded when the matrix is read: the command tables and the models that read the matrix are
// themselves part of the graph wshrpcutil pulls in, and a static import would load them half defined.
export async function fetchFeatureMatrix(): Promise<FeatureMatrix> {
    const { TabRpcClient } = await import("@/app/store/wshrpcutil");
    return TabRpcClient.wshRpcCall(GetCommand, null, { route: RouteId, timeout: GetTimeoutMs });
}

export function agentRow(matrix: FeatureMatrix, agent: string): AgentFeatures {
    if (!agent) {
        return null;
    }
    return matrix?.agents?.find((a) => a.id === agent) ?? null;
}

// The row of a catalog or guide profile id (the onboarding's "claude-code"), or of an agent id.
export function agentRowByProfile(matrix: FeatureMatrix, profile: string): AgentFeatures {
    if (!profile) {
        return null;
    }
    return matrix?.agents?.find((a) => a.profile === profile) ?? agentRow(matrix, profile);
}

// agentFeature is one cell; an agent or a feature the matrix does not know works as none, never as supported.
export function agentFeature(matrix: FeatureMatrix, agent: string, feature: string): FeatureSupport {
    return agentRow(matrix, agent)?.features?.[feature] ?? Unknown;
}

// featureWorks: MoltenTerm can offer the feature with that agent (native or adapted).
export function featureWorks(matrix: FeatureMatrix, agent: string, feature: string): boolean {
    const level = agentFeature(matrix, agent, feature).level;
    return level === "native" || level === "adapted";
}

// The agents a feature works with, in the matrix's order.
export function agentsWith(matrix: FeatureMatrix, feature: string): string[] {
    return (matrix?.agents ?? []).filter((a) => featureWorks(matrix, a.id, feature)).map((a) => a.id);
}

// The agent's own name from its row; its id when the matrix does not know it.
export function agentDisplayName(matrix: FeatureMatrix, agent: string): string {
    if (!agent) {
        return "";
    }
    return agentRow(matrix, agent)?.name || agent;
}

// How the agent calls a molten guide ("$morph" in Codex).
export function guideCall(matrix: FeatureMatrix, agent: string, guide: string): string {
    return (agentRow(matrix, agent)?.guidecall || DefaultGuideCall).replace("{name}", guide);
}

// The guide's call for every agent the guides work with, the agents sharing a call grouped in the matrix's order.
export function guideCalls(matrix: FeatureMatrix, guide: string): { agents: string[]; call: string }[] {
    const rtn: { agents: string[]; call: string }[] = [];
    for (const id of agentsWith(matrix, "guides")) {
        const call = guideCall(matrix, id, guide);
        const group = rtn.find((g) => g.call === call);
        const name = agentDisplayName(matrix, id);
        if (group != null) {
            group.agents.push(name);
        } else {
            rtn.push({ agents: [name], call });
        }
    }
    return rtn;
}

// The matrix wavesrv answered, read once: it is static data (no poller, no event). Read again after a failure.
export class AgentFeaturesModel {
    private static instance: AgentFeaturesModel = null;

    matrixAtom = atom(null) as PrimitiveAtom<FeatureMatrix>;
    loading = false;
    retryAt = 0;

    private constructor() {}

    static getInstance(): AgentFeaturesModel {
        if (AgentFeaturesModel.instance == null) {
            AgentFeaturesModel.instance = new AgentFeaturesModel();
        }
        return AgentFeaturesModel.instance;
    }

    // current answers the matrix it has and reads it when it has none; surfaces that render read matrixAtom.
    current(): FeatureMatrix {
        const matrix = globalStore.get(this.matrixAtom);
        if (matrix == null) {
            this.load();
        }
        return matrix;
    }

    setMatrix(matrix: FeatureMatrix) {
        globalStore.set(this.matrixAtom, matrix);
    }

    load() {
        if (this.loading || Date.now() < this.retryAt) {
            return;
        }
        this.loading = true;
        fireAndForget(async () => {
            try {
                this.setMatrix(await fetchFeatureMatrix());
            } catch (e) {
                this.retryAt = Date.now() + RetryMs;
                console.log("[agent-features] the matrix could not be read", e);
            } finally {
                this.loading = false;
            }
        });
    }
}

export function currentFeatureMatrix(): FeatureMatrix {
    return AgentFeaturesModel.getInstance().current();
}

export function useFeatureMatrix(): FeatureMatrix {
    const model = AgentFeaturesModel.getInstance();
    const matrix = useAtomValue(model.matrixAtom, { store: globalStore });
    useEffect(() => {
        if (matrix == null) {
            model.load();
        }
    }, [matrix]);
    return matrix;
}
