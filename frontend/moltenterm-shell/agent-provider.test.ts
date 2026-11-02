// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-AGC-008: a Claude Code run behind another provider is named with it, and the Anthropic lists say they are.

import { describe, expect, it, vi } from "vitest";

import {
    agentProviderLabel,
    agentProviderName,
    agentProviderTitle,
    AgentStateInfo,
    agentToolName,
} from "./agent-state-model";
import { effortItem, modelItem } from "./command-panel/agent-commands";

const anthropic: AgentStateInfo = {
    blockid: "b1",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Valentin",
    state: "idle",
    version: 1,
    model: "glm-4.6",
    effort: "high",
};
const glm: AgentStateInfo = { ...anthropic, provider: "api.z.ai", providername: "GLM", nativeprovider: "Anthropic" };

function handlers() {
    return {
        run: vi.fn(async () => "close" as const),
        setMode: vi.fn(async () => "close" as const),
        setEffort: vi.fn(async () => "close" as const),
        setModel: vi.fn(async () => "close" as const),
    };
}

describe("provider behind Claude Code (FR-AGC-008)", () => {
    it("names the provider with the tool", () => {
        expect(agentProviderName(anthropic)).toBe("");
        expect(agentToolName(anthropic)).toBe("Claude Code");
        expect(agentProviderLabel(anthropic)).toBe("Valentin · Claude Code");
        expect(agentProviderName(glm)).toBe("GLM");
        expect(agentToolName(glm)).toBe("Claude Code via GLM");
        expect(agentProviderLabel(glm)).toBe("Valentin · Claude Code via GLM");
        expect(agentProviderTitle(glm)).toBe("Claude Code sends its requests to api.z.ai, not to Anthropic");
        expect(agentProviderTitle(anthropic)).toBe("");
    });

    it("names an unknown host by itself", () => {
        const gw: AgentStateInfo = { ...anthropic, provider: "llm.gateway.internal", providername: "" };
        expect(agentToolName(gw)).toBe("Claude Code via llm.gateway.internal");
    });

    it("marks the models and effort levels as the agent's own provider's", () => {
        const info = { blockid: "b1", efforts: ["low", "high"], models: [{ id: "opus", label: "Opus" }] };
        const def = {
            action: "model",
            label: "Model",
            labelKey: "cmdpanel.agent.model",
            icon: "microchip",
            command: "/model",
        };
        const effort = effortItem(glm, info, "claude", handlers());
        expect(effort.options.map((o) => o.detail)).toEqual([
            "Anthropic level: GLM may ignore it",
            "Anthropic level: GLM may ignore it",
        ]);
        const model = modelItem(glm, info, def, handlers());
        expect(model.options.find((o) => o.id === "model:opus").detail).toBe(
            "Anthropic model: GLM may swap it for one of its own"
        );
        const plain = effortItem(anthropic, info, "claude", handlers());
        expect(plain.options[0].detail).toBe("Saved as your default");
    });
});
