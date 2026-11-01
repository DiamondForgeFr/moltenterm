// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-AGC-003 (#1684): at a cold start, before wavesrv answers, the interface offers what it offered before from the
// matrix shipped in the build; the route only refreshes it. No test matrix is set in this file.

import { describe, expect, it, vi } from "vitest";

// wavesrv never answers during this test.
const rpc = vi.hoisted(() => ({ wshRpcCall: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: rpc }));

import { codingAgentIds, codingAgentName, rememberedProjectAgent } from "../coding-agent/coding-agent";
import { agentCommandTable, agentTakesModes, ClaudeCommands, CodexCommands } from "../command-panel/agent-commands";
import { agentName } from "../companion/companion-task-model";
import { morphCall } from "../morph/morph-call-model";
import { AgentFeaturesModel, agentsWith, currentFeatureMatrix } from "./agent-features-model";

describe("cold start (FR-AGC-003)", () => {
    it("gives Claude Code and Codex their lists and names before wavesrv answers", () => {
        const matrix = currentFeatureMatrix();
        expect(AgentFeaturesModel.getInstance().refreshed).toBe(false);
        expect(rpc.wshRpcCall).toHaveBeenCalledTimes(0);
        expect(codingAgentIds()).toEqual(["claude", "codex"]);
        expect(agentsWith(matrix, "usage")).toEqual(["claude", "codex"]);
        expect(agentsWith(matrix, "launcher")).toEqual(["claude", "codex"]);
        expect(agentsWith(matrix, "statusline")).toEqual(["claude"]);
        expect(agentCommandTable("claude")).toBe(ClaudeCommands);
        expect(agentCommandTable("codex")).toBe(CodexCommands);
        expect(agentTakesModes("claude")).toBe(true);
        expect(morphCall("codex")).toBe("$morph");
        expect([codingAgentName("claude"), agentName("codex"), agentName("gemini")]).toEqual([
            "Claude Code",
            "Codex",
            "Gemini CLI",
        ]);
        expect(rememberedProjectAgent("")).toBeUndefined();
    });

    it("asks wavesrv once, and keeps the build's matrix while it does not answer", async () => {
        currentFeatureMatrix();
        await vi.waitFor(() => expect(rpc.wshRpcCall).toHaveBeenCalledTimes(1), { timeout: 30000 });
        currentFeatureMatrix();
        expect(rpc.wshRpcCall).toHaveBeenCalledTimes(1);
        expect(codingAgentIds()).toEqual(["claude", "codex"]);
    });
});
