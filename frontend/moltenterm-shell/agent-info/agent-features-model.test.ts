// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

import { agentFeature, featureWorks, type FeatureMatrix } from "./agent-features-model";

const Matrix: FeatureMatrix = {
    asof: "2026-11-01",
    features: [{ id: "browsermcp", name: "molten-browser MCP", requires: ["mcp"] }],
    agents: [
        {
            id: "claude",
            name: "Claude Code",
            adapter: true,
            features: { browsermcp: { level: "adapted", note: "per run" } },
        },
        {
            id: "gemini",
            name: "Gemini CLI",
            adapter: false,
            features: { browsermcp: { level: "none", reason: "noadapter" } },
        },
        {
            id: "opencode",
            name: "OpenCode",
            adapter: false,
            features: { state: { level: "process-only", reason: "nohooks" } },
        },
    ],
};

describe("agent features model", () => {
    it("reads a cell of the matrix", () => {
        expect(agentFeature(Matrix, "claude", "browsermcp").level).toBe("adapted");
        expect(featureWorks(Matrix, "claude", "browsermcp")).toBe(true);
        expect(featureWorks(Matrix, "gemini", "browsermcp")).toBe(false);
        expect(featureWorks(Matrix, "opencode", "state")).toBe(false);
    });

    it("treats an unknown agent, feature or matrix as none", () => {
        expect(agentFeature(Matrix, "aider", "browsermcp")).toEqual({ level: "none", reason: "noadapter" });
        expect(agentFeature(Matrix, "claude", "teleport").level).toBe("none");
        expect(featureWorks(null, "claude", "browsermcp")).toBe(false);
    });
});
