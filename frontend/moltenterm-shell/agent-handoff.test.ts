// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

import { AgentHandoffAnswerCommand, AgentHandoffRouteId, answerAgentHandoff, readHandoffAnswer } from "./agent-handoff";

describe("handoff approval answers (FR-CONT-015, NFR-CONT-005)", () => {
    beforeEach(() => {
        Mocks.call.mockReset();
    });

    it("reads the request and one of the four decisions only", () => {
        expect(readHandoffAnswer({ requestid: " r1 ", decision: "always" })).toEqual({ requestid: "r1", decision: "always" });
        expect(readHandoffAnswer({ requestid: "r1", decision: "approve" })).toBeNull();
        expect(readHandoffAnswer({ decision: "once" })).toBeNull();
        expect(readHandoffAnswer(null)).toBeNull();
    });

    it("sends the answer to wavesrv's handoff route and resolves the question", async () => {
        Mocks.call.mockResolvedValue(null);
        const result = await answerAgentHandoff({ requestid: "r1", decision: "block" });
        expect(result).toEqual({ ok: true, resolve: true });
        expect(Mocks.call).toHaveBeenCalledWith(
            AgentHandoffAnswerCommand,
            { requestid: "r1", decision: "block" },
            expect.objectContaining({ route: AgentHandoffRouteId })
        );
    });

    it("reports a request that stopped waiting", async () => {
        Mocks.call.mockRejectedValue(new Error("This handoff request is no longer waiting"));
        const result = await answerAgentHandoff({ requestid: "r1", decision: "once" });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("no longer waiting");
        expect(await answerAgentHandoff({ decision: "once" })).toMatchObject({ ok: false });
    });
});
