// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

import {
    AgentHandoffAnswerCommand,
    AgentHandoffRouteId,
    answerAgentHandoff,
    handoffAnswerError,
    readHandoffAnswer,
} from "./agent-handoff";
import { I18nModel, t } from "./i18n/i18n";

function setLanguage(code: string) {
    I18nModel.getInstance().setLanguageSetting(code);
}

describe("handoff approval answers (FR-CONT-015, NFR-CONT-005)", () => {
    beforeEach(() => {
        Mocks.call.mockReset();
    });

    it("reads the request and one of the four decisions only", () => {
        expect(readHandoffAnswer({ requestid: " r1 ", decision: "always" })).toEqual({
            requestid: "r1",
            decision: "always",
        });
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

    // #1129: every failed answer is a sentence of the interface language, the raw error only as its detail.
    it("words each failure in the interface language", async () => {
        setLanguage("fr");
        try {
            Mocks.call.mockRejectedValue(
                new Error('uimsg:{"code":"handoff.notwaiting"}\nThis handoff request is no longer waiting')
            );
            expect((await answerAgentHandoff({ requestid: "r1", decision: "once" })).error).toBe(
                "Cette demande de passage de relais n'est plus en attente."
            );
            expect(handoffAnswerError(new Error("EC-TIME: timeout waiting for response"))).toBe(
                t("agent.handoffAnswerTimeout")
            );
            expect(handoffAnswerError(new Error("no route for molten:agenthandoff"))).toBe(
                "Votre réponse à ce passage de relais n'a pas pu être transmise (no route for molten:agenthandoff)."
            );
            expect(handoffAnswerError(new Error(""))).toBe(t("agent.handoffAnswerFailedBare"));
            setLanguage("en");
            expect(handoffAnswerError(new Error("EC-TIME: timeout waiting for response"))).toContain(
                "did not answer in time"
            );
        } finally {
            setLanguage("en");
        }
    });
});
