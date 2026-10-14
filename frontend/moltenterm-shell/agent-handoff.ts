// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Handing work to another agent by first name (FR-CONT-015, NFR-CONT-005): the first send between two agents raises a
// notification (pkg/molten/agenthandoff) whose buttons run this gesture, which gives the developer's answer to
// wavesrv's handoff route. Only a window may answer: wavesrv refuses an answer from a terminal.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "./i18n/i18n";
import { NotificationGestureResult } from "./notifications-store";

// must match pkg/molten/handoffwire/handoffwire.go
export const AgentHandoffRouteId = "molten:agenthandoff";
export const AgentHandoffAnswerCommand = "moltenagenthandoffanswer";
export const AgentHandoffGesture = "molten:agenthandoff";

export type AgentHandoffDecision = "once" | "always" | "block" | "dismiss";

export type AgentHandoffAnswer = { requestid: string; decision: AgentHandoffDecision };

const Decisions: AgentHandoffDecision[] = ["once", "always", "block", "dismiss"];
const AnswerTimeoutMs = 5000;

export function readHandoffAnswer(args: Record<string, any>): AgentHandoffAnswer {
    const requestid = typeof args?.requestid === "string" ? args.requestid.trim() : "";
    const decision = args?.decision as AgentHandoffDecision;
    if (!requestid || !Decisions.includes(decision)) {
        return null;
    }
    return { requestid, decision };
}

export async function answerAgentHandoff(args: Record<string, any>): Promise<NotificationGestureResult> {
    const answer = readHandoffAnswer(args);
    if (answer == null) {
        return { ok: false, error: t("agent.handoffUnreadable") };
    }
    try {
        await TabRpcClient.wshRpcCall(AgentHandoffAnswerCommand, answer, {
            route: AgentHandoffRouteId,
            timeout: AnswerTimeoutMs,
        });
    } catch (e) {
        // The agent stopped waiting (50 seconds) or MoltenTerm restarted: the request is gone, so is its question.
        return { ok: false, resolve: true, error: e?.message ?? String(e) };
    }
    return { ok: true, resolve: true };
}
