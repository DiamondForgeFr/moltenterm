// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The SaaSFoundryAI and hand-off cards of a brainstormed project (FR-BOSS-010 AC16, #2251), pure so that they are
// tested without a window: when each card shows, what its click sends of the preview the developer saw, and which
// sentence a refusal says. wavesrv previews and acts (pkg/molten/brainstorm/launch.go); the window never builds a
// command line itself. The setup types the harness profile whichever profile is chosen: the full profile comes second,
// by the update of a folder set up already, after its dry run.

import type { BrainstormState } from "./brainstorm-boot";
import type { BrainstormGraph, ProposalAction } from "./brainstorm-graph-model";

// must match pkg/molten/brainstorm/launch.go
export type LaunchStep = "setup" | "handoff";
export const Profiles = ["full", "harness"] as const;
export type Profile = (typeof Profiles)[number];
// The preview's commands: the harness setup, the update to the full profile, and its dry run.
export const NewKey = "new";
export const UpdateKey = "update";
export const DryRunKey = "dryrun";
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
    "nodryrun",
    "drymutated",
    "invalid",
    "failed",
] as const;
// The window's own: wavesrv did not answer the click, so whether the terminal opened is not known (the card looks again).
export const LaunchWindowFailures = ["unknown"] as const;
export type LaunchFailure = (typeof LaunchRefusals)[number] | (typeof LaunchWindowFailures)[number];

// How SaaSFoundryAI installs, shown when it is missing: the developer runs it, MoltenTerm never does.
export const SfInstallCommand = "npm install -g saasfoundryai-cli";

// profile: the profile the developer chose for the setup (full comes in two steps).
export type Launch = {
    step: LaunchStep | "update";
    at: number;
    dir: string;
    workspace: string;
    tab: string;
    block: string;
    command?: string;
    profile?: string;
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
    // The setup's terminal while it is there, and the update's.
    launched?: Launch;
    update?: Launch;
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

// dryrun: the status of the dry run the card showed, which the update acts on.
export type LaunchExpect = { dir: string; workspace: string; command?: string; agent?: string; dryrun?: string };

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

// The command the click types, exactly as wavesrv previewed it: the update on a folder set up already, else the harness
// setup, whichever profile is chosen; "" when there is none to type.
export function setupCommand(preview: SetupPreview): string {
    if (preview == null) {
        return "";
    }
    return preview.commands?.[preview.managed ? UpdateKey : NewKey] ?? "";
}

// What the setup's click sends of the preview the developer saw: wavesrv acts only on it. The update also sends the
// status of the dry run the card showed.
export function setupExpect(preview: SetupPreview, dryRun?: DryRun): LaunchExpect {
    const expect: LaunchExpect = {
        dir: preview?.dir ?? "",
        workspace: preview?.workspace ?? "",
        command: setupCommand(preview),
    };
    if (preview?.managed && dryRun?.status) {
        expect.dryrun = dryRun.status;
    }
    return expect;
}

export function handoffExpect(preview: HandoffPreview): LaunchExpect {
    return { dir: preview?.dir ?? "", workspace: preview?.workspace ?? "", agent: preview?.agent ?? "" };
}

// The setup's click may go. Before the folder is set up: a profile chosen, no setup terminal yet, the harness command.
// Once it is: no update terminal yet, and a dry run that said the full profile can be added.
export function canSetup(preview: SetupPreview, profile: string, busy: boolean, dryRun?: DryRun): boolean {
    if (busy || preview == null || preview.refusal || setupCommand(preview) === "") {
        return false;
    }
    if (preview.managed) {
        return preview.update == null && dryRunView(dryRun) === "adds";
    }
    return preview.launched == null && isProfile(profile);
}

// What stands in the way of a brief: nothing, it is empty, or it is over MaxHandoffBrief characters.
export function briefProblem(brief: string): "" | "empty" | "toolong" {
    if ((brief ?? "").trim() === "") {
        return "empty";
    }
    return brief.length > MaxHandoffBrief ? "toolong" : "";
}

// The hand-off's click may go: an agent to start, nothing started yet, a brief that says something, within bounds.
export function canHandoff(preview: HandoffPreview, brief: string, busy: boolean): boolean {
    if (busy || preview == null || preview.refusal || preview.launched != null || !preview.agent) {
        return false;
    }
    return briefProblem(brief) === "";
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

// The developer chose the full profile for the setup: its second step, the update, follows once the folder is set up.
export function fullInTwoSteps(preview: SetupPreview, profile: string): boolean {
    return (preview?.launched?.profile ?? profile) === "full";
}
