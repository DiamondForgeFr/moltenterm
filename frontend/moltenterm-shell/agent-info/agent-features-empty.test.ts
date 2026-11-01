// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-AGC-003: an empty answer from wavesrv counts as a failed read, so the build's matrix stands.

import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ wshRpcCall: vi.fn(async () => null) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: rpc }));

import { AgentFeaturesModel, BuiltMatrix, currentFeatureMatrix } from "./agent-features-model";

describe("empty answer (FR-AGC-003)", () => {
    it("keeps the build's matrix when wavesrv answers nothing", async () => {
        currentFeatureMatrix();
        const model = AgentFeaturesModel.getInstance();
        await vi.waitFor(() => expect(rpc.wshRpcCall).toHaveBeenCalledTimes(1), { timeout: 30000 });
        await vi.waitFor(() => expect(model.loading).toBe(false), { timeout: 30000 });
        expect(model.refreshed).toBe(false);
        expect(currentFeatureMatrix()).toBe(BuiltMatrix);
    });
});
