// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { restingPose } from "./brokk-ask-model";
import { brokkPose } from "./brokk-state-model";
import {
    canSend,
    IdleTalk,
    keepsText,
    MaxMessageLength,
    SayResult,
    SendingTalk,
    talkNoteKey,
    talkPose,
    talkStateOf,
} from "./brokk-talk-model";

describe("what a message does (FR-BOSS-009, AC15)", () => {
    it("reads each answer of his session", () => {
        for (const status of ["sent", "busy", "noagent", "agentmissing"] as const) {
            expect(talkStateOf({ status }).phase).toBe(status);
        }
        expect(talkStateOf({ status: "failed", reason: "gone" })).toMatchObject({ phase: "failed", reason: "gone" });
        expect(talkStateOf({ status: "none" }).phase).toBe("failed");
        expect(talkStateOf(null).phase).toBe("failed");
    });

    it("keeps the agent's name and whether this message started the session", () => {
        const state = talkStateOf({ status: "sent", started: true, agentname: "Claude Code" } as SayResult);
        expect(state).toMatchObject({ phase: "sent", started: true, agentName: "Claude Code" });
    });

    it("sends a message that has text and fits, while none is on its way", () => {
        expect(canSend("hello", IdleTalk)).toBe(true);
        expect(canSend("   ", IdleTalk)).toBe(false);
        expect(canSend("", IdleTalk)).toBe(false);
        expect(canSend("x".repeat(MaxMessageLength + 1), IdleTalk)).toBe(false);
        expect(canSend("hello", SendingTalk)).toBe(false);
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
        expect(talkNoteKey(talkStateOf({ status: "sent" }))).toBeNull();
        expect(talkNoteKey(talkStateOf({ status: "sent", started: true }))).toBe("boss.panel.talk.sentStarted");
        expect(talkNoteKey(talkStateOf({ status: "busy" }))).toBe("boss.panel.talk.busy");
        expect(talkNoteKey(talkStateOf({ status: "noagent" }))).toBe("boss.panel.talk.noAgent");
        expect(talkNoteKey(talkStateOf({ status: "agentmissing" }))).toBe("boss.panel.talk.agentMissing");
        expect(talkNoteKey(talkStateOf({ status: "failed", reason: "gone" }))).toBe("boss.panel.talk.gone");
        expect(talkNoteKey(talkStateOf({ status: "failed", reason: "noagent" }))).toBe("boss.panel.talk.agentStopped");
        expect(talkNoteKey(talkStateOf({ status: "failed" }))).toBe("boss.panel.talk.failed");
    });
});

describe("his face with the field (FR-BOSS-009, AC9; FR-BOSS-007)", () => {
    const open = { working: 0, waiting: 0, cardOpen: true };

    it("answers with a pose for what the field is doing", () => {
        expect(talkPose(false, false)).toBeNull();
        expect(talkPose(true, false)).toBe("typing");
        expect(talkPose(true, true)).toBe("answering");
        expect(talkPose(false, true)).toBe("answering");
    });

    it("listens while the developer writes", () => {
        expect(restingPose({ ...open, cardOpen: false, talk: "typing" })).toBe("listening");
        expect(brokkPose({ ...open, talk: "typing" }, { speaking: false, expression: null })).toBe("listening");
    });

    it("speaks while his own session answers, even with nothing waiting", () => {
        expect(brokkPose({ ...open, talk: "answering" }, { speaking: false, expression: null })).toBe("speaking");
    });

    it("does not speak for the talk field when it is idle", () => {
        expect(brokkPose(open, { speaking: false, expression: null })).toBe("listening");
    });
});
