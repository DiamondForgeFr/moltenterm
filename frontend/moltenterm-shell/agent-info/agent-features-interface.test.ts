// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-AGC-003 (#1684): the lists the interface kept by hand, read from wavesrv's real matrix, give what they gave
// before; a fake matrix with one more agent offers it where its features work, with no interface change.

import { describe, expect, it } from "vitest";
import { fullIntegration } from "../../moltenterm-onboarding/onboarding-pour-agents";
import { codingAgentIds, codingAgentName } from "../coding-agent/coding-agent";
import { agentCommandTable, agentTakesModes, ClaudeCommands, CodexCommands } from "../command-panel/agent-commands";
import { agentName } from "../companion/companion-task-model";
import { pipelineInvocations } from "../mission/mission-model";
import { morphCall } from "../morph/morph-call-model";
import { matrixWith, RealMatrix, setTestMatrix } from "./agent-features-fixture";
import { agentsWith, featureWorks, guideCall, type AgentFeatures } from "./agent-features-model";

function fakeAgent(features: AgentFeatures["features"]): AgentFeatures {
    return { id: "aider", name: "Aider", adapter: true, profile: "aider", guidecall: "/{name}", features };
}

const Adapted = { level: "adapted" as const, note: "fake", adapter: "fake" };

describe("the interface reads the matrix (FR-AGC-003)", () => {
    it("gives the lists it kept by hand for Claude Code and Codex", () => {
        setTestMatrix(RealMatrix);
        // CodingAgentIds
        expect(codingAgentIds()).toEqual(["claude", "codex"]);
        // UsageAgents, IntegratedAgents, UsageSourceAgent
        expect(agentsWith(RealMatrix, "usage")).toEqual(["claude", "codex"]);
        expect(agentsWith(RealMatrix, "launcher")).toEqual(["claude", "codex"]);
        expect(agentsWith(RealMatrix, "statusline")).toEqual(["claude"]);
        // The command tables' agents and their permission modes
        expect(agentCommandTable("claude")).toBe(ClaudeCommands);
        expect(agentCommandTable("codex")).toBe(CodexCommands);
        expect(agentCommandTable("gemini")).toBeNull();
        expect(agentTakesModes("claude")).toBe(true);
        expect(agentTakesModes("codex")).toBe(false);
        // FullIntegrationIds, by catalog id
        expect(
            ["claude-code", "codex", "gemini-cli", "qwen-code", "kimi"].filter((id) => fullIntegration(RealMatrix, id))
        ).toEqual(["claude-code", "codex"]);
        // MorphCalls
        expect(["claude", "codex", "kimi", "gemini", "opencode", undefined].map((a) => morphCall(a))).toEqual([
            "/morph",
            "$morph",
            "/skill:morph",
            "/morph",
            "/morph",
            "/morph",
        ]);
        // PipelineInvocations (Qwen Code joins when the matrix has its row, FR-AGC-002)
        expect(pipelineInvocations(RealMatrix)).toEqual([
            { agent: "Claude Code, Gemini CLI", invocation: "/molten-pipeline" },
            { agent: "Codex", invocation: "$molten-pipeline" },
            { agent: "Kimi Code", invocation: "/skill:molten-pipeline" },
        ]);
        // The agent name tables
        expect(["claude", "codex", "gemini", "kimi", "opencode"].map(agentName)).toEqual([
            "Claude Code",
            "Codex",
            "Gemini CLI",
            "Kimi Code",
            "OpenCode",
        ]);
        expect(codingAgentName("codex")).toBe("Codex");
        expect(agentName("aider")).toBe("aider");
    });

    it("offers a new agent where the matrix says its features work, with its own name and call", () => {
        const matrix = matrixWith(
            fakeAgent({ runner: Adapted, usage: Adapted, browsermcp: Adapted, guides: Adapted, state: Adapted })
        );
        setTestMatrix(matrix);
        try {
            expect(codingAgentIds()).toEqual(["claude", "codex", "aider"]);
            expect(featureWorks(matrix, "aider", "usage")).toBe(true);
            expect(featureWorks(matrix, "aider", "launcher")).toBe(false);
            expect(fullIntegration(matrix, "aider")).toBe(true);
            expect(agentName("aider")).toBe("Aider");
            expect(guideCall(matrix, "aider", "morph")).toBe("/morph");
            expect(pipelineInvocations(matrix)[0].agent).toBe("Claude Code, Gemini CLI, Aider");
            // No command table for it: the matrix cell alone does not invent one.
            expect(agentCommandTable("aider")).toBeNull();
        } finally {
            setTestMatrix(RealMatrix);
        }
    });

    it("offers nothing to an agent without a row, or with no matrix at all", () => {
        expect(agentsWith(null, "runner")).toEqual([]);
        expect(agentCommandTable("aider")).toBeNull();
        expect(agentName("aider")).toBe("aider");
    });
});
