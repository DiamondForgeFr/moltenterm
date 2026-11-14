// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The SaaSFoundryAI and hand-off cards of a brainstormed project (FR-BOSS-010 AC16, #2251), pure so that they are
// tested without a window: when each card shows, what its click sends of the preview the developer saw, and which
// sentence a refusal says. wavesrv previews and acts (pkg/molten/brainstorm/launch.go); the window never builds a
// command line itself.

import type { BrainstormState } from "./brainstorm-boot";
import type { BrainstormGraph, ProposalAction } from "./brainstorm-graph-model";

// must match pkg/molten/brainstorm/launch.go
export type LaunchStep = "setup" | "handoff";
export const Profiles = ["full", "harness"] as const;
export type Profile = (typeof Profiles)[number];
export const UpdateKey = "update";
export const MaxHandoffBrief = 12000;
export const LaunchRefusals = [
    "noproject",
    "nobrief",
    "nosf",
    "noprofile",
    "noagent",
    "agentmissing",
    "terminal",
    "notmanaged",
    "invalid",
    "failed",
] as const;
// The window's own: wavesrv did not answer the click, so whether the terminal opened is not known (the card looks again).
export const LaunchWindowFailures = ["unknown"] as const;
export type LaunchFailure = (typeof LaunchRefusals)[number] | (typeof LaunchWindowFailures)[number];

// How SaaSFoundryAI installs, shown when it is missing: the developer runs it, MoltenTerm never does.
export const SfInstallCommand = "npm install -g saasfoundryai-cli";

export type Launch = {
    step: LaunchStep;
    at: number;
    dir: string;
    workspace: string;
    tab: string;
    block: string;
    command?: string;
    agent?: string;
    agentname?: string;
    typed: boolean;
};

export type SetupPreview = {
    dir?: string;
    workspace?: string;
    sf: boolean;
    managed?: boolean;
    profile?: string;
    profilereason?: string;
    name?: string;
    commands?: Record<string, string>;
    refusal?: string;
    launched?: Launch;
};

export type DryRun = {
    status: string;
    current?: string;
    code?: string;
    add: number;
    compatible: number;
    conflict: number;
    unsupported: number;
    canapply: boolean;
    npm?: boolean;
};

export type SetupResult = {
    preview: SetupPreview;
    dryrun?: DryRun;
    launch?: Launch;
    already?: boolean;
    stale?: boolean;
    error?: string;
};

export type HandoffAgent = { id: string; name: string; installed: boolean };

export type HandoffPreview = {
    dir?: string;
    workspace?: string;
    agent?: string;
    agentname?: string;
    missing?: boolean;
    chosenname?: string;
    agents: HandoffAgent[];
    brief?: string;
    refusal?: string;
    launched?: Launch;
};

export type HandoffResult = {
    preview: HandoffPreview;
    launch?: Launch;
    already?: boolean;
    stale?: boolean;
    error?: string;
};

export type LaunchExpect = { dir: string; workspace: string; command?: string; agent?: string };

const StepAction: Record<LaunchStep, ProposalAction> = { setup: "saasfoundry", handoff: "handoff" };

// His proposal of that step on the graph, not set aside.
export function hasStepProposal(graph: BrainstormGraph, step: LaunchStep): boolean {
    const action = StepAction[step];
    return (graph?.nodes ?? []).some((n) => n.kind === "proposal" && n.action === action && n.status !== "aside");
}

// What a card is: absent (no proposal of his, or set aside), waiting for the project (made and linked to its
// workspace), or ready.
export type LaunchCard = { kind: "none" } | { kind: "waiting" } | { kind: "ready" };

export function launchCardOf(state: BrainstormState, step: LaunchStep): LaunchCard {
    if (state?.open !== true || state.brainstorm == null || !hasStepProposal(state.graph, step)) {
        return { kind: "none" };
    }
    const promotion = state.brainstorm.promotedto;
    if (!promotion?.dir || !promotion.workspace || state.brief == null) {
        return { kind: "waiting" };
    }
    return { kind: "ready" };
}

export function isProfile(value: string): value is Profile {
    return (Profiles as readonly string[]).includes(value);
}

// The profile the card starts on: his recommendation, else none until the developer picks one.
export function startingProfile(preview: SetupPreview): Profile | "" {
    const profile = preview?.profile ?? "";
    return isProfile(profile) ? profile : "";
}

// The command the click types, exactly as wavesrv previewed it: the update on a folder set up already, else the chosen
// profile's; "" when there is none to type.
export function setupCommand(preview: SetupPreview, profile: string): string {
    if (preview == null) {
        return "";
    }
    const key = preview.managed ? UpdateKey : profile;
    return preview.commands?.[key] ?? "";
}

// What the setup's click sends of the preview the developer saw: wavesrv acts only on it.
export function setupExpect(preview: SetupPreview, profile: string): LaunchExpect {
    return { dir: preview?.dir ?? "", workspace: preview?.workspace ?? "", command: setupCommand(preview, profile) };
}

export function handoffExpect(preview: HandoffPreview): LaunchExpect {
    return { dir: preview?.dir ?? "", workspace: preview?.workspace ?? "", agent: preview?.agent ?? "" };
}

// The setup's click may go: a preview with nothing in the way, nothing opened yet, a command to type.
export function canSetup(preview: SetupPreview, profile: string, busy: boolean): boolean {
    if (busy || preview == null || preview.refusal || preview.launched != null) {
        return false;
    }
    return setupCommand(preview, profile) !== "";
}

// The hand-off's click may go: an agent to start, nothing started yet, a brief within bounds.
export function canHandoff(preview: HandoffPreview, brief: string, busy: boolean): boolean {
    if (busy || preview == null || preview.refusal || preview.launched != null || !preview.agent) {
        return false;
    }
    return (brief ?? "").length <= MaxHandoffBrief;
}

// The brief the click sends: the developer's edit, else the preview's.
export function briefToSend(edited: string, preview: HandoffPreview): string {
    return edited != null ? edited : (preview?.brief ?? "");
}

export function installedAgents(preview: HandoffPreview): HandoffAgent[] {
    return (preview?.agents ?? []).filter((a) => a.installed);
}

// The key of the sentence a refusal says; an unknown code says that it did not work.
export function launchRefusalKey(code: string): string {
    const known =
        (LaunchRefusals as readonly string[]).includes(code) ||
        (LaunchWindowFailures as readonly string[]).includes(code);
    return `boss.brainstorm.launch.refused.${known ? code : "failed"}`;
}

// What the dry run of a folder set up already says: full already, what the full profile adds, or that it cannot.
export type DryRunView = "full" | "adds" | "blocked";

export function dryRunView(dryRun: DryRun): DryRunView {
    if (dryRun?.status === "noop") {
        return "full";
    }
    return dryRun?.status === "ready" && dryRun.canapply ? "adds" : "blocked";
}
