// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What step 3, "Your project and your sessions" (FR-ONB-004, DS-ONB-004), decides, kept apart from the component so
// it is tested without a window: the folders it proposes, the colour a project gets, and how the user's agent connects
// it to Mission Control.

import { GenericAgentId, guideRequest, OnboardingAgent } from "./onboarding-agent-model";

// must match pkg/molten/onboarding/projects.go
export const OnboardingProjectsCommand = "onboardingprojects";

export const MaxShownCandidates = 8;
export const PipelineGuideName = "molten-pipeline";

// The step's data key holding the folder chosen.
export const ProjectFolderKey = "folder";

// must match WorkspaceColors in pkg/wcore/workspace.go
export const WorkspaceColours = ["#FF7C0D", "#00FFDB", "#429DFF", "#BF55EC", "#FF453A", "#58C142", "#FFE900"];

export type ProjectCandidate = { path: string; name: string; modtime?: number; recent?: boolean };

function baseName(path: string): string {
    const trimmed = (path ?? "").replace(/[/\\]+$/, "");
    const parts = trimmed.split(/[/\\]/);
    return parts[parts.length - 1] || trimmed;
}

// The workspace's recent folders first (the user went there already), then the repositories found, each folder once.
export function projectCandidates(
    recent: string[],
    scanned: ProjectCandidate[],
    max = MaxShownCandidates
): ProjectCandidate[] {
    const seen = new Set<string>();
    const rtn: ProjectCandidate[] = [];
    const add = (c: ProjectCandidate) => {
        const key = (c.path ?? "").replace(/[/\\]+$/, "");
        if (!key || seen.has(key) || rtn.length >= max) {
            return;
        }
        seen.add(key);
        rtn.push({ ...c, path: key });
    };
    for (const path of recent ?? []) {
        add({ path, name: baseName(path), recent: true });
    }
    for (const c of scanned ?? []) {
        add({ path: c.path, name: c.name || baseName(c.path), modtime: c.modtime });
    }
    return rtn;
}

// The same project keeps the same colour across workspaces and runs.
export function projectColour(name: string): string {
    let hash = 0;
    for (const ch of name ?? "") {
        hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    }
    return WorkspaceColours[hash % WorkspaceColours.length];
}

// The request that connects the project to Mission Control, in the agent's syntax; any agent can follow the generic
// sentence.
export function pipelineCall(agent: OnboardingAgent, generic: OnboardingAgent): string {
    const guide = agent?.guides?.find((g) => g.name === PipelineGuideName);
    if (guide != null && agent.id !== GenericAgentId) {
        return guide.invocation.replace(/\s*<request>\s*$/, "").trim();
    }
    const genericGuide = generic?.guides?.find((g) => g.name === PipelineGuideName);
    if (genericGuide != null) {
        return guideRequest(genericGuide.invocation, "connect this project to Mission Control");
    }
    return "/molten-pipeline";
}
