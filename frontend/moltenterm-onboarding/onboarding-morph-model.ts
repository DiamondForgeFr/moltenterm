// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What step 2, "Your first morph" (FR-ONB-003, DS-ONB-003), decides, kept apart from the component so it is tested
// without a window: the agent the step can start, the requests it proposes in that agent's syntax, and the mod that
// ticks it.

import type { MoltenModStatus } from "../molten/molten-host";
import { canMorph, ChosenAgentKey, guideRequest, OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import type { OnboardingState } from "./onboarding-state";

// must match pkg/molten/onboarding/agents.go
export const OnboardingMorphDirCommand = "onboardingmorphdir";

// The step's data keys.
export const MorphTermKey = "term";
export const MorphBaselineKey = "baseline";
export const MorphModKey = "mod";

// Small, read-only and undoable: the first is the one the step proposes, the others its alternatives.
export const MorphRequests = [
    "add a command that shows the current git branch in a box",
    "add a command that shows today's date and the week number in a box",
    "add a command that lists the ports listening on this machine in a box",
];

// The mod states that mean "enabled": pending only waits for the tab view to show (FR-PERF-014).
const EnabledStates = new Set(["active", "pending", "loading"]);

export type MorphedMod = { id: string; name: string; commands: string[] };

// The agent step 1 kept, while it is still found; null sends the step to its no-agent path.
export function morphAgent(state: OnboardingState, list: OnboardingAgents): OnboardingAgent {
    const id = state?.data?.agent?.[ChosenAgentKey];
    if (!id) {
        return null;
    }
    const agent = (list?.agents ?? []).find((a) => a.id === id);
    return agent?.found && canMorph(agent) && agent.executable ? agent : null;
}

export function morphRequests(agent: OnboardingAgent): string[] {
    if (agent == null) {
        return [];
    }
    return MorphRequests.map((request) => guideRequest(agent.invocation, request));
}

export function enabledUserMods(mods: MoltenModStatus[]): MoltenModStatus[] {
    return (mods ?? []).filter((m) => !m.builtin && EnabledStates.has(m.state));
}

export function enabledModIds(mods: MoltenModStatus[]): string[] {
    return enabledUserMods(mods)
        .map((m) => m.id)
        .sort();
}

// The first user mod enabled since the step took its baseline; none while there is no baseline yet.
export function newMod(mods: MoltenModStatus[], baseline: string[]): MorphedMod {
    if (!Array.isArray(baseline)) {
        return null;
    }
    const mod = enabledUserMods(mods).find((m) => !baseline.includes(m.id));
    if (mod == null) {
        return null;
    }
    return { id: mod.id, name: mod.name || mod.id, commands: [...(mod.commands ?? [])] };
}

// The mod the step recorded, read back from its data.
export function readMorphedMod(data: Record<string, any>): MorphedMod {
    const raw = data?.[MorphModKey];
    if (raw == null || typeof raw.id !== "string") {
        return null;
    }
    const commands = Array.isArray(raw.commands) ? raw.commands.filter((c: unknown) => typeof c === "string") : [];
    return { id: raw.id, name: typeof raw.name === "string" && raw.name ? raw.name : raw.id, commands };
}

// The copy box shown without an agent, and the molten line that shows the same box.
export const CopyDemoTitle = "Your first box";
export const CopyDemoText = "Hello from MoltenTerm";
export const CopyDemoCommand = `molten copy --title "${CopyDemoTitle}" ${CopyDemoText}`;
