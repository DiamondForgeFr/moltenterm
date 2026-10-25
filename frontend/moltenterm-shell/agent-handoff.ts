// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Handing work to another agent by first name (FR-CONT-015, NFR-CONT-005): the first send between two agents raises a
// notification (pkg/molten/agenthandoff) whose buttons run this gesture, which gives the developer's answer to
// wavesrv's handoff route. Only a window may answer: wavesrv refuses an answer from a terminal.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "./i18n/i18n";
import { serverErrorText, unwireError } from "./i18n/server-text";
import { NotificationGestureResult } from "./notifications-store";

// must match pkg/molten/handoffwire/handoffwire.go
export const AgentHandoffRouteId = "molten:agenthandoff";
export const AgentHandoffAnswerCommand = "moltenagenthandoffanswer";
export const AgentHandoffGesture = "molten:agenthandoff";

export type AgentHandoffDecision = "once" | "always" | "block" | "dismiss";

export type AgentHandoffAnswer = { requestid: string; decision: AgentHandoffDecision };

const Decisions: AgentHandoffDecision[] = ["once", "always", "block", "dismiss"];
const AnswerTimeoutMs = 5000;
// must match the timeout error of frontend/app/store/wshrpcutil-base.ts
const RpcTimeoutCode = "EC-TIME";

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
        // The request was cancelled or MoltenTerm restarted: the request is gone, so is its question. An agent that
        // stopped waiting still takes the answer (#790).
        return { ok: false, resolve: true, error: handoffAnswerError(e) };
    }
    return { ok: true, resolve: true };
}

// handoffAnswerError words a failed answer: wavesrv's coded refusals in their own words, anything else (the call timed
// out, the route is gone) in a sentence of ours with the raw error as its detail (#1129).
export function handoffAnswerError(e: unknown): string {
    const message = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
    const { text, english } = unwireError(message);
    if (text?.code) {
        return serverErrorText(e);
    }
    if (english.includes(RpcTimeoutCode)) {
        return t("agent.handoffAnswerTimeout");
    }
    const detail = english.trim();
    return detail ? t("agent.handoffAnswerFailed", { detail }) : t("agent.handoffAnswerFailedBare");
}
