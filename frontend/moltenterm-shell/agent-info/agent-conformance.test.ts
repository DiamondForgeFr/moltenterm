// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The frontend part of the adapter conformance suite (FR-AGC-006): every cell of the compatibility matrix whose code
// lives here (an FS/ adapter) is checked against that code, for every agent of the matrix. The matrix comes from
// agent-features.golden.json, which pkg/molten/agentcontinuity's TestMatrixGolden keeps equal to wavesrv's; its
// TestConformanceCoherence requires a case here, by title, for each such cell.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: async () => null } }));
vi.mock("@/app/store/global", () => ({
    globalStore: { get: () => 0, set: () => {} },
    getFocusedBlockId: () => null,
    refocusNode: () => {},
}));

import { runningInTerminal } from "../busy-close-model";
import { agentCommandTable, hasAgentCommands } from "../command-panel/agent-commands";
import { agentCopyProfile } from "../term-copy/agent-copy-profiles";
import { setTestMatrix } from "./agent-features-fixture";
import { featureWorks, type FeatureMatrix } from "./agent-features-model";
import Golden from "./agent-features.golden.json";

const Matrix = Golden as FeatureMatrix;
setTestMatrix(Matrix);
const AgentIds = Matrix.agents.map((a) => a.id);

// The features delivered by frontend code, each with its check below.
const FrontendFeatures = ["termcopy", "commands", "busyclose"];

function level(agent: string, feature: string): string {
    return Matrix.agents.find((a) => a.id === agent)?.features?.[feature]?.level;
}

describe("agent conformance (FR-AGC-006)", () => {
    it("knows every feature the matrix delivers from the frontend", () => {
        expect(Matrix.agents.length).toBeGreaterThan(0);
        const fromFrontend = new Set<string>();
        for (const agent of Matrix.agents) {
            for (const [feature, cell] of Object.entries(agent.features)) {
                if (cell.adapter?.includes("FS/") && featureWorks(Matrix, agent.id, feature)) {
                    fromFrontend.add(feature);
                }
            }
        }
        expect([...fromFrontend].sort()).toEqual([...FrontendFeatures].sort());
    });

    describe("termcopy", () => {
        it.each(AgentIds)("%s", (agent) => {
            const profile = agentCopyProfile(agent);
            if (featureWorks(Matrix, agent, "termcopy")) {
                expect(profile.id).toBe(agent);
                expect(profile.gutters.length).toBeGreaterThan(0);
                return;
            }
            expect(profile.id).toBe("");
        });
    });

    describe("commands", () => {
        it.each(AgentIds)("%s", (agent) => {
            const info = { blockid: "b1", agent, state: "idle" as const, version: 1 };
            if (featureWorks(Matrix, agent, "commands")) {
                expect(agentCommandTable(agent)?.length).toBeGreaterThan(0);
                expect(hasAgentCommands(info)).toBe(true);
                return;
            }
            expect(agentCommandTable(agent)).toBeNull();
            expect(hasAgentCommands(info)).toBe(false);
        });
    });

    describe("busyclose", () => {
        it.each(AgentIds)("%s", (agent) => {
            const cell = level(agent, "busyclose");
            if (cell === "native") {
                const item = runningInTerminal({
                    blockId: "b1",
                    view: "term",
                    agent: { blockid: "b1", agent, state: "working", version: 1 },
                });
                expect(item?.kind).toBe("agent");
                expect(item?.state).toBe("working");
                return;
            }
            if (cell === "process-only") {
                const item = runningInTerminal({
                    blockId: "b1",
                    view: "term",
                    integration: true,
                    shellState: "running-command",
                    lastCmd: agent,
                });
                expect(item?.kind).toBe("command");
                expect(item?.label).toBe(agent);
                return;
            }
            expect(cell).toBe("none");
        });
    });
});
