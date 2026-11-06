// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The field at the foot of Brokk's panel (FR-BOSS-009, AC9 and AC15, #2003): what a message does and what the field says
// about it. Pure, so the rules are tested without a window or a session.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

// must match pkg/molten/brokksession/session.go
export type SayStatus = "none" | "ready" | "sent" | "busy" | "noagent" | "agentmissing" | "failed";

export type SayResult = {
    status: SayStatus;
    reason?: string;
    blockid?: string;
    tabid?: string;
    agent?: string;
    agentname?: string;
    started?: boolean;
    message?: string;
};

export const MaxMessageLength = 4000;

// idle: nothing to say; sending: on its way; the others are the last answer.
export type TalkPhase = "idle" | "sending" | "sent" | "busy" | "noagent" | "agentmissing" | "failed";

export type TalkState = { phase: TalkPhase; reason: string; agentName: string; started: boolean };

export const IdleTalk: TalkState = { phase: "idle", reason: "", agentName: "", started: false };

export const SendingTalk: TalkState = { ...IdleTalk, phase: "sending" };

export function talkStateOf(result: SayResult): TalkState {
    const phase: TalkPhase =
        result?.status === "sent" ||
        result?.status === "busy" ||
        result?.status === "noagent" ||
        result?.status === "agentmissing"
            ? result.status
            : "failed";
    return {
        phase,
        reason: result?.reason ?? "",
        agentName: result?.agentname ?? "",
        started: result?.started === true,
    };
}

// A message goes when it has text, fits, and the previous one is not on its way.
export function canSend(text: string, state: TalkState): boolean {
    const trimmed = text.trim();
    return trimmed !== "" && trimmed.length <= MaxMessageLength && state.phase !== "sending";
}

// The text leaves the field only once the agent has it: a busy agent, a missing one or a failure keep it for another try.
export function keepsText(state: TalkState): boolean {
    return state.phase !== "sent";
}

// The line under the field, as an interface key; null says nothing.
export function talkNoteKey(state: TalkState): string {
    switch (state.phase) {
        case "sending":
            return "boss.panel.talk.sending";
        case "sent":
            return state.started ? "boss.panel.talk.sentStarted" : null;
        case "busy":
            return "boss.panel.talk.busy";
        case "noagent":
            return "boss.panel.talk.noAgent";
        case "agentmissing":
            return "boss.panel.talk.agentMissing";
        case "failed":
            if (state.reason === "gone") {
                return "boss.panel.talk.gone";
            }
            return state.reason === "noagent" ? "boss.panel.talk.agentStopped" : "boss.panel.talk.failed";
        default:
            return null;
    }
}

// What his face does with the field: he listens while the developer writes, and speaks while his own session answers.
export function talkPose(typing: boolean, answering: boolean): "typing" | "answering" {
    if (answering) {
        return "answering";
    }
    return typing ? "typing" : null;
}
