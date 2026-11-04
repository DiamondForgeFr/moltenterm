// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The facts every agent line says in the same order (#1848, FR-REV-022 AC2 and AC9, parity #987): after its name, its
// CLI, its model, its effort. A lead's, a sub-agent's, Claude Code's and Codex's lines are worded here and nowhere
// else: the Integration agent bar and session lines, the sidebar's sub-agent tooltip and the agent info window. A fact
// the agent did not report is left out, never guessed.

import { agentToolName, type AgentStateInfo } from "./agent-state-model";
import { modelDisplayName } from "./companion/companion-proportion";

export type AgentFacts = {
    cli?: string;
    model?: string;
    // The model as the agent itself names it, when it gave no id.
    modelName?: string;
    effort?: string;
};

// A terminal's agent as its run last reported it (Claude Code's status line, Codex's rollout), with the provider behind
// the run ("Claude Code via GLM").
export function agentRunFacts(info: AgentStateInfo): AgentFacts {
    return { cli: agentToolName(info), model: info?.model, modelName: info?.modelname, effort: info?.effort };
}

// "Opus 5.5" for claude-opus-5-5, "gpt-5.5" as given; the agent's own name for its model when no id is known.
export function agentModelText(model?: string, modelName?: string): string {
    return modelDisplayName(model) || (modelName ?? "").trim();
}

// The known facts, in the order of every agent line: CLI, model, effort.
export function agentFactParts(facts: AgentFacts): string[] {
    return [
        (facts?.cli ?? "").trim(),
        agentModelText(facts?.model, facts?.modelName),
        (facts?.effort ?? "").trim(),
    ].filter((part) => !!part);
}

// The facts joined as a line ("Codex · gpt-5.5 · high"), then what follows them (a sub-agent's task).
export function agentFactsLine(facts: AgentFacts, ...after: string[]): string {
    return [...agentFactParts(facts), ...after.map((part) => (part ?? "").trim())].filter((part) => !!part).join(" · ");
}
