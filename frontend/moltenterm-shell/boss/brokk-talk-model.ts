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
    workspaceid?: string;
    agent?: string;
    agentname?: string;
    started?: boolean;
    message?: string;
};

// must match the Reply… statuses of pkg/molten/brokksession/session.go
export type ReplyStatus = "answer" | "waiting" | "unread" | "none";

export type ReplyResult = {
    status: ReplyStatus;
    blockid?: string;
    tabid?: string;
    workspaceid?: string;
    index?: number;
    rev?: number;
    at?: number;
    markdown?: string;
};

export const MaxMessageLength = 4000;

// idle: nothing to say; starting: the first message starts his session; sending: on its way; answering: his agent has
// it and works on it (reply: what he answered so far); answered: his answer is here; unread: he answered in his
// terminal, where the panel cannot read it; noreply: no answer came; needsanswer: his agent stopped on a prompt in his
// hidden terminal (a permission, a trust question) and waits for the developer there. The others are the failures of
// the message.
export type TalkPhase =
    | "idle"
    | "starting"
    | "sending"
    | "answering"
    | "needsanswer"
    | "answered"
    | "unread"
    | "noreply"
    | "busy"
    | "noagent"
    | "agentmissing"
    | "failed";

// Where his terminal is: the way out when his answer is only there.
export type TalkWhere = { workspaceid: string; tabid: string; blockid: string };

export type TalkState = {
    phase: TalkPhase;
    reason: string;
    agentName: string;
    started: boolean;
    reply: string;
    where: TalkWhere;
};

export const IdleTalk: TalkState = { phase: "idle", reason: "", agentName: "", started: false, reply: "", where: null };

export const SendingTalk: TalkState = { ...IdleTalk, phase: "sending" };

export const StartingTalk: TalkState = { ...IdleTalk, phase: "starting" };

export function whereOf(result: { blockid?: string; tabid?: string; workspaceid?: string }): TalkWhere {
    if (!result?.blockid || !result?.tabid) {
        return null;
    }
    return { workspaceid: result.workspaceid ?? "", tabid: result.tabid, blockid: result.blockid };
}

// What the answer to a message says; a message his agent has goes on to wait for his answer.
export function talkStateOf(result: SayResult): TalkState {
    const status = result?.status;
    const phase: TalkPhase =
        status === "sent"
            ? "answering"
            : status === "busy" || status === "noagent" || status === "agentmissing"
              ? status
              : "failed";
    return {
        phase,
        reason: result?.reason ?? "",
        agentName: result?.agentname ?? "",
        started: result?.started === true,
        reply: "",
        where: whereOf(result),
    };
}

// How long his answer is followed: an agent that never shows it working, or a reply that cannot be read, is given up
// on after these many readings in a row without work.
export const FollowEveryMs = 1500;
export const IdleReadingsForNoReply = 20;
export const IdleReadingsForUnread = 3;
export const IdleReadingsForAnswered = 2;
export const FailedReadingsForNoReply = 5;
export const MaxFollowMs = 20 * 60 * 1000;

// idle: readings in a row while his agent did not work; worked: it was seen working since the message.
export type Follow = { idle: number; failed: number; worked: boolean };

export const StartFollow: Follow = { idle: 0, failed: 0, worked: false };

// One reading of his answer: the next state, and whether to keep following. working: his agent works now (the ring);
// waiting: his agent's state says it waits for the developer (#2155). A wait is no silence: it is said, the way to his
// terminal is offered, and the following goes on, so that his answer is read once the developer has answered there.
export function followStep(
    state: TalkState,
    follow: Follow,
    reply: ReplyResult,
    working: boolean,
    waiting = false
): { state: TalkState; follow: Follow; done: boolean } {
    if (waiting && reply?.status !== "none") {
        const where = whereOf(reply) ?? state.where;
        const said = reply?.status === "answer" ? (reply.markdown ?? "") : state.reply;
        return {
            state: { ...state, phase: "needsanswer", reply: said, where },
            follow: { ...follow, idle: 0, failed: 0 },
            done: false,
        };
    }
    if (state.phase === "needsanswer") {
        state = { ...state, phase: "answering" };
    }
    if (reply == null) {
        const failed = follow.failed + 1;
        if (failed >= FailedReadingsForNoReply) {
            return { state: { ...state, phase: "noreply" }, follow: { ...follow, failed }, done: true };
        }
        return { state, follow: { ...follow, failed }, done: false };
    }
    const where = whereOf(reply) ?? state.where;
    if (reply.status === "none") {
        return { state: { ...state, phase: "failed", reason: "gone", where: null }, follow, done: true };
    }
    const idle = working ? 0 : follow.idle + 1;
    const next: Follow = { idle, failed: 0, worked: follow.worked || working };
    if (reply.status === "answer") {
        const answering: TalkState = { ...state, phase: "answering", reply: reply.markdown ?? "", where };
        if (idle >= IdleReadingsForAnswered) {
            return { state: { ...answering, phase: "answered" }, follow: next, done: true };
        }
        return { state: answering, follow: next, done: false };
    }
    // A reply that cannot be read is in his terminal once his agent worked on the message and stopped.
    if (
        reply.status === "unread" &&
        ((next.worked && idle >= IdleReadingsForUnread) || idle >= IdleReadingsForNoReply)
    ) {
        return { state: { ...state, phase: "unread", where }, follow: next, done: true };
    }
    if (idle >= IdleReadingsForNoReply) {
        return { state: { ...state, phase: "noreply", where }, follow: next, done: true };
    }
    return { state: { ...state, where }, follow: next, done: false };
}

// A message goes when it has text, fits, and the previous one is not on its way.
export function canSend(text: string, state: TalkState): boolean {
    const trimmed = text.trim();
    return trimmed !== "" && trimmed.length <= MaxMessageLength && !onItsWay(state);
}

export function onItsWay(state: TalkState): boolean {
    return state.phase === "sending" || state.phase === "starting";
}

// The text leaves the field only once the agent has it: a busy agent, a missing one or a failure keep it for another try.
export function keepsText(state: TalkState): boolean {
    return !(
        state.phase === "answering" ||
        state.phase === "needsanswer" ||
        state.phase === "answered" ||
        state.phase === "unread" ||
        state.phase === "noreply"
    );
}

// The domino turns while the developer waits for him.
export function talkWaits(state: TalkState): boolean {
    return onItsWay(state) || state.phase === "answering";
}

// The line under the field, as an interface key; null says nothing.
export function talkNoteKey(state: TalkState): string {
    switch (state.phase) {
        case "starting":
            return "boss.panel.talk.starting";
        case "sending":
            return "boss.panel.talk.sending";
        case "answering":
            return "boss.panel.talk.thinking";
        case "needsanswer":
            return "boss.panel.talk.needsAnswer";
        case "unread":
            return "boss.panel.talk.unread";
        case "noreply":
            return "boss.panel.talk.noReply";
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
            if (state.reason === "notsubmitted") {
                return "boss.panel.talk.notSubmitted";
            }
            return state.reason === "noagent" ? "boss.panel.talk.agentStopped" : "boss.panel.talk.failed";
        default:
            return null;
    }
}

export type TalkWayOut = "chooseAgent" | "retry" | "openTerminal";

// The way out of a failure: no failure is left without one (#2028).
export function talkWayOut(state: TalkState): TalkWayOut {
    switch (state.phase) {
        case "noagent":
        case "agentmissing":
            return "chooseAgent";
        case "busy":
            return "retry";
        case "needsanswer":
            return state.where != null ? "openTerminal" : null;
        case "unread":
        case "noreply":
            return state.where != null ? "openTerminal" : "retry";
        case "failed":
            if ((state.reason === "noagent" || state.reason === "notsubmitted") && state.where != null) {
                return "openTerminal";
            }
            return "retry";
        default:
            return null;
    }
}

export function talkWayOutKey(way: TalkWayOut): string {
    switch (way) {
        case "chooseAgent":
            return "boss.panel.talk.chooseAgent";
        case "retry":
            return "boss.panel.talk.retry";
        case "openTerminal":
            return "boss.panel.talk.openTerminal";
        default:
            return null;
    }
}

export type TalkPoseInput = {
    // The developer has text in the field.
    typing: boolean;
    // A message is on its way, or his agent has it and his answer is not complete.
    awaiting: boolean;
    // His own session works (the ring turns).
    working: boolean;
    // His answer is coming in, or came a moment ago (brokk-exchange-model.ts SpeakingHoldMs).
    speaking: boolean;
};

// What his face does with the conversation (FR-BOSS-009, AC25): he speaks while his answer comes in, thinks from the
// moment his agent takes a message (or whenever his own session works) until the answer is there, and listens while the
// developer writes. Otherwise the field says nothing to his face.
export function talkPose(input: TalkPoseInput): "typing" | "thinking" | "answering" {
    if (input.speaking) {
        return "answering";
    }
    if (input.awaiting || input.working) {
        return "thinking";
    }
    return input.typing ? "typing" : null;
}
