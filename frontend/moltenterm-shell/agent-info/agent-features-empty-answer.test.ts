// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-AGC-003 (#1684): an empty answer from wavesrv does not replace the matrix shipped in the build, or the interface
// would offer nothing to any agent.

import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ wshRpcCall: vi.fn(async () => null) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: rpc }));

import { codingAgentIds } from "../coding-agent/coding-agent";
import { AgentFeaturesModel, BuiltMatrix, currentFeatureMatrix } from "./agent-features-model";

describe("empty answer (FR-AGC-003)", () => {
    it("keeps the build's matrix when wavesrv answers nothing", async () => {
        currentFeatureMatrix();
        await vi.waitFor(() => expect(AgentFeaturesModel.getInstance().loading).toBe(false), { timeout: 30000 });
        expect(rpc.wshRpcCall).toHaveBeenCalledTimes(1);
        expect(AgentFeaturesModel.getInstance().refreshed).toBe(false);
        expect(currentFeatureMatrix()).toBe(BuiltMatrix);
        expect(codingAgentIds()).toEqual(["claude", "codex"]);
    });
});
