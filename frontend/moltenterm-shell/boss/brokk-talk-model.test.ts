// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { restingPose } from "./brokk-ask-model";
import { brokkPose } from "./brokk-state-model";
import {
    canSend,
    FailedReadingsForNoReply,
    followStep,
    IdleReadingsForAnswered,
    IdleReadingsForNoReply,
    IdleReadingsForUnread,
    IdleTalk,
    keepsText,
    MaxMessageLength,
    SayResult,
    SendingTalk,
    StartFollow,
    StartingTalk,
    talkNoteKey,
    talkPose,
    talkStateOf,
    talkWayOut,
    talkWayOutKey,
} from "./brokk-talk-model";

describe("what a message does (FR-BOSS-009, AC15)", () => {
    it("reads each answer of his session", () => {
        expect(talkStateOf({ status: "sent" }).phase).toBe("answering");
        for (const status of ["busy", "noagent", "agentmissing"] as const) {
            expect(talkStateOf({ status }).phase).toBe(status);
        }
        expect(talkStateOf({ status: "failed", reason: "gone" })).toMatchObject({ phase: "failed", reason: "gone" });
        expect(talkStateOf({ status: "none" }).phase).toBe("failed");
        expect(talkStateOf(null).phase).toBe("failed");
    });

    it("keeps the agent's name, whether this message started the session, and where his terminal is", () => {
        const state = talkStateOf({
            status: "sent",
            started: true,
            agentname: "Claude Code",
            blockid: "b",
            tabid: "t",
            workspaceid: "w",
        } as SayResult);
        expect(state).toMatchObject({ phase: "answering", started: true, agentName: "Claude Code" });
        expect(state.where).toEqual({ workspaceid: "w", tabid: "t", blockid: "b" });
    });

    it("sends a message that has text and fits, while none is on its way", () => {
        expect(canSend("hello", IdleTalk)).toBe(true);
        expect(canSend("   ", IdleTalk)).toBe(false);
        expect(canSend("", IdleTalk)).toBe(false);
        expect(canSend("x".repeat(MaxMessageLength + 1), IdleTalk)).toBe(false);
        expect(canSend("hello", SendingTalk)).toBe(false);
        expect(canSend("hello", StartingTalk)).toBe(false);
        expect(canSend("hello", { ...IdleTalk, phase: "answering" })).toBe(true);
    });

    it("clears the field only once the agent has the text", () => {
        expect(keepsText(talkStateOf({ status: "sent" }))).toBe(false);
        for (const status of ["busy", "noagent", "agentmissing", "failed"] as const) {
            expect(keepsText(talkStateOf({ status })), status).toBe(true);
        }
    });

    it("says what happened under the field, in interface keys", () => {
        expect(talkNoteKey(IdleTalk)).toBeNull();
        expect(talkNoteKey(SendingTalk)).toBe("boss.panel.talk.sending");
        expect(talkNoteKey(StartingTalk)).toBe("boss.panel.talk.starting");
        expect(talkNoteKey(talkStateOf({ status: "sent" }))).toBe("boss.panel.talk.thinking");
        expect(talkNoteKey({ ...IdleTalk, phase: "answered", reply: "Two." })).toBeNull();
        expect(talkNoteKey({ ...IdleTalk, phase: "unread" })).toBe("boss.panel.talk.unread");
        expect(talkNoteKey({ ...IdleTalk, phase: "noreply" })).toBe("boss.panel.talk.noReply");
        expect(talkNoteKey(talkStateOf({ status: "busy" }))).toBe("boss.panel.talk.busy");
        expect(talkNoteKey(talkStateOf({ status: "noagent" }))).toBe("boss.panel.talk.noAgent");
        expect(talkNoteKey(talkStateOf({ status: "agentmissing" }))).toBe("boss.panel.talk.agentMissing");
        expect(talkNoteKey(talkStateOf({ status: "failed", reason: "gone" }))).toBe("boss.panel.talk.gone");
        expect(talkNoteKey(talkStateOf({ status: "failed", reason: "noagent" }))).toBe("boss.panel.talk.agentStopped");
        expect(talkNoteKey(talkStateOf({ status: "failed" }))).toBe("boss.panel.talk.failed");
    });

    it("gives every failure a way out (#2028)", () => {
        const where = { workspaceid: "w", tabid: "t", blockid: "b" };
        expect(talkWayOut(talkStateOf({ status: "noagent" }))).toBe("chooseAgent");
        expect(talkWayOut(talkStateOf({ status: "agentmissing" }))).toBe("chooseAgent");
        expect(talkWayOut(talkStateOf({ status: "busy" }))).toBe("retry");
        expect(talkWayOut(talkStateOf({ status: "failed" }))).toBe("retry");
        expect(talkWayOut(talkStateOf({ status: "failed", reason: "gone" }))).toBe("retry");
        expect(talkWayOut(talkStateOf(null))).toBe("retry");
        expect(talkWayOut({ ...IdleTalk, phase: "failed", reason: "noagent", where })).toBe("openTerminal");
        expect(talkWayOut({ ...IdleTalk, phase: "failed", reason: "notsubmitted", where })).toBe("openTerminal");
        expect(talkNoteKey({ ...IdleTalk, phase: "failed", reason: "notsubmitted" })).toBe(
            "boss.panel.talk.notSubmitted"
        );
        expect(talkWayOut({ ...IdleTalk, phase: "unread", where })).toBe("openTerminal");
        expect(talkWayOut({ ...IdleTalk, phase: "noreply", where })).toBe("openTerminal");
        for (const phase of ["idle", "sending", "starting", "answering", "answered"] as const) {
            expect(talkWayOut({ ...IdleTalk, phase }), phase).toBeNull();
        }
        for (const way of ["chooseAgent", "retry", "openTerminal"] as const) {
            expect(talkWayOutKey(way)).toMatch(/^boss\.panel\.talk\./);
        }
    });
});

describe("his answer comes back to the panel (#2028)", () => {
    const answering = talkStateOf({ status: "sent", blockid: "b", tabid: "t", workspaceid: "w" });

    it("shows his answer while he works, and keeps it once he is done", () => {
        const reply = { status: "answer" as const, markdown: "Two agents run now.", blockid: "b", tabid: "t" };
        let step = followStep(answering, StartFollow, reply, true);
        expect(step).toMatchObject({ done: false, state: { phase: "answering", reply: "Two agents run now." } });
        for (let i = 0; i < IdleReadingsForAnswered; i++) {
            step = followStep(step.state, step.follow, reply, false);
        }
        expect(step).toMatchObject({ done: true, state: { phase: "answered", reply: "Two agents run now." } });
    });

    it("waits for an answer while his agent works on the message", () => {
        let step = { state: answering, follow: StartFollow, done: false };
        for (let i = 0; i < IdleReadingsForNoReply * 2; i++) {
            step = followStep(step.state, step.follow, { status: "waiting" }, true);
        }
        expect(step).toMatchObject({ done: false, state: { phase: "answering", reply: "" } });
    });

    it("points to his terminal when no answer comes while his agent does nothing", () => {
        let step = { state: answering, follow: StartFollow, done: false };
        for (let i = 0; i < IdleReadingsForNoReply && !step.done; i++) {
            step = followStep(step.state, step.follow, { status: "waiting" }, false);
        }
        expect(step).toMatchObject({ done: true, state: { phase: "noreply" } });
        expect(talkWayOut(step.state)).toBe("openTerminal");
    });

    it("says he answered in his terminal when his answer cannot be read", () => {
        let step = followStep(answering, StartFollow, { status: "unread" }, true);
        for (let i = 0; i < IdleReadingsForUnread; i++) {
            step = followStep(step.state, step.follow, { status: "unread" }, false);
        }
        expect(step).toMatchObject({ done: true, state: { phase: "unread" } });
    });

    it("does not call an unreadable answer given before his agent even started on it", () => {
        let step = followStep(answering, StartFollow, { status: "unread" }, false);
        for (let i = 0; i < IdleReadingsForUnread; i++) {
            step = followStep(step.state, step.follow, { status: "unread" }, false);
        }
        expect(step.done).toBe(false);
    });

    it("says his terminal is gone when his session no longer exists", () => {
        const step = followStep(answering, StartFollow, { status: "none" }, false);
        expect(step).toMatchObject({ done: true, state: { phase: "failed", reason: "gone" } });
    });

    it("gives up on readings that keep failing, with his terminal as the way out", () => {
        let step = { state: answering, follow: StartFollow, done: false };
        for (let i = 0; i < FailedReadingsForNoReply; i++) {
            step = followStep(step.state, step.follow, null, true);
        }
        expect(step).toMatchObject({ done: true, state: { phase: "noreply" } });
    });
});

describe("his face with the field (FR-BOSS-009, AC9; FR-BOSS-007)", () => {
    const open = { working: 0, waiting: 0, cardOpen: true };

    const quiet = { typing: false, awaiting: false, working: false, speaking: false };

    it("answers with a pose for what the conversation is doing (AC25)", () => {
        expect(talkPose(quiet)).toBeNull();
        expect(talkPose({ ...quiet, typing: true })).toBe("typing");
        expect(talkPose({ ...quiet, awaiting: true })).toBe("thinking");
        expect(talkPose({ ...quiet, working: true })).toBe("thinking");
        expect(talkPose({ ...quiet, speaking: true })).toBe("answering");
    });

    it("thinks from the moment his agent takes a message, and speaks over thinking once his words come in", () => {
        expect(talkPose({ ...quiet, typing: true, awaiting: true })).toBe("thinking");
        expect(talkPose({ ...quiet, awaiting: true, working: true, speaking: true })).toBe("answering");
    });

    it("listens again once the answer is complete and he has finished speaking", () => {
        expect(talkPose({ ...quiet, typing: true })).toBe("typing");
        expect(talkPose(quiet)).toBeNull();
    });

    it("listens while the developer writes", () => {
        expect(restingPose({ ...open, cardOpen: false, talk: "typing" })).toBe("listening");
        expect(brokkPose({ ...open, talk: "typing" }, { speaking: false, expression: null })).toBe("listening");
    });

    it("thinks while his session works on a message, whatever else works or waits", () => {
        expect(brokkPose({ ...open, talk: "thinking" }, { speaking: false, expression: null })).toBe("thinking");
        expect(
            brokkPose(
                { working: 2, waiting: 3, cardOpen: true, talk: "thinking" },
                { speaking: false, expression: null }
            )
        ).toBe("thinking");
    });

    it("speaks while his own session answers, even with nothing waiting", () => {
        expect(brokkPose({ ...open, talk: "answering" }, { speaking: false, expression: null })).toBe("speaking");
    });

    it("does not speak for the talk field when it is idle", () => {
        expect(brokkPose(open, { speaking: false, expression: null })).toBe("listening");
    });
});
