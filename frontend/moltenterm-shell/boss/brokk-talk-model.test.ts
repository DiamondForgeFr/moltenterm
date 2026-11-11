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
    MaxFieldLines,
    MaxMessageLength,
    queuedOf,
    SayResult,
    sendsOnKey,
    talkFieldHeight,
    SendingTalk,
    StartFollow,
    StartingTalk,
    talkNoteKey,
    talkPose,
    TalkState,
    talkStateOf,
    talkTerminalAside,
    talkWaits,
    talkWayOut,
    talkWayOutKey,
    UnreachableReason,
} from "./brokk-talk-model";
import En from "../i18n/locales/en.json";
import Fr from "../i18n/locales/fr.json";

function textAt(texts: unknown, key: string): string {
    return key.split(".").reduce((node: any, part) => node?.[part], texts) as string;
}

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
        expect(talkNoteKey(talkStateOf({ status: "failed" }))).toBe("boss.panel.talk.unreachable");
    });

    // #2237: the field was one line that scrolled sideways. It grows with the message, then scrolls inside itself.
    it("grows with the message up to six lines, then scrolls, and shrinks back to one (#2237)", () => {
        const line = 18;
        const pad = 8;
        expect(MaxFieldLines).toBe(6);
        expect(talkFieldHeight(0, line, pad)).toBe(line + pad);
        expect(talkFieldHeight(line + pad, line, pad)).toBe(line + pad);
        expect(talkFieldHeight(3 * line + pad, line, pad)).toBe(3 * line + pad);
        expect(talkFieldHeight(6 * line + pad, line, pad)).toBe(6 * line + pad);
        expect(talkFieldHeight(40 * line + pad, line, pad)).toBe(6 * line + pad);
    });

    it("sends on Enter and makes a new line on Shift+Enter or while a word is composed (#2237)", () => {
        expect(sendsOnKey({ key: "Enter" })).toBe(true);
        expect(sendsOnKey({ key: "Enter", shiftKey: true })).toBe(false);
        expect(sendsOnKey({ key: "Enter", isComposing: true })).toBe(false);
        expect(sendsOnKey({ key: "a" })).toBe(false);
        expect(textAt(En, "boss.panel.talk.keys")).toMatch(/Shift\+Enter/);
        expect(textAt(Fr, "boss.panel.talk.keys")).toMatch(/Maj\+Entrée/);
    });

    // #2236: a message his terminal refused (it was too long for the hand-off's line) said "his session is
    // unreachable", the one note of every failure. Each cause now says its own, in both languages, with its way out.
    it("says each cause of a failure in its own words, with its own way out (#2236)", () => {
        const where = { workspaceid: "w", tabid: "t", blockid: "b" };
        const causes: [SayResult, string, string][] = [
            [{ status: "failed", reason: "refused", ...where }, "boss.panel.talk.refused", "retry"],
            [{ status: "failed", reason: "refused" }, "boss.panel.talk.refused", "retry"],
            [{ status: "failed", reason: "terminal" }, "boss.panel.talk.noTerminal", "retry"],
            [{ status: "failed", reason: "nospace" }, "boss.panel.talk.noSpace", "retry"],
            [{ status: "failed", reason: "notext" }, "boss.panel.talk.noText", "retry"],
            [{ status: "failed", reason: "lookup" }, "boss.panel.talk.lookupFailed", "retry"],
            [{ status: "failed", reason: "gone" }, "boss.panel.talk.gone", "retry"],
            [{ status: "failed", reason: "noagent", ...where }, "boss.panel.talk.agentStopped", "retry"],
            [{ status: "failed", reason: "notsubmitted", ...where }, "boss.panel.talk.notSubmitted", "retry"],
            [{ status: "failed", reason: "humandraft", ...where }, "boss.panel.talk.humanDraft", "retry"],
            [null, "boss.panel.talk.unreachable", "retry"],
        ];
        for (const [result, key, way] of causes) {
            const state = talkStateOf(result);
            expect(talkNoteKey(state), JSON.stringify(result)).toBe(key);
            expect(talkWayOut(state), JSON.stringify(result)).toBe(way);
            for (const [lang, texts] of [
                ["en", En],
                ["fr", Fr],
            ] as const) {
                const text = textAt(texts, key);
                expect(text, `${lang} ${key}`).toMatch(/\S/);
                expect(text, `${lang} ${key}`).not.toMatch(/injoignable|could not be reached/);
            }
        }
        expect(new Set(causes.map(([, key]) => key)).size).toBe(10);
        expect(talkStateOf(null).reason).toBe(UnreachableReason);
    });

    it("gives every failure a way out (#2028)", () => {
        const where = { workspaceid: "w", tabid: "t", blockid: "b" };
        expect(talkWayOut(talkStateOf({ status: "noagent" }))).toBe("chooseAgent");
        expect(talkWayOut(talkStateOf({ status: "agentmissing" }))).toBe("chooseAgent");
        expect(talkWayOut(talkStateOf({ status: "busy" }))).toBe("retry");
        expect(talkWayOut(talkStateOf({ status: "failed" }))).toBe("retry");
        expect(talkWayOut(talkStateOf({ status: "failed", reason: "gone" }))).toBe("retry");
        expect(talkWayOut(talkStateOf(null))).toBe("retry");
        expect(talkNoteKey({ ...IdleTalk, phase: "failed", reason: "notsubmitted" })).toBe(
            "boss.panel.talk.notSubmitted"
        );
        for (const phase of ["idle", "sending", "starting", "queued", "answering", "answered"] as const) {
            expect(talkWayOut({ ...IdleTalk, phase }), phase).toBeNull();
        }
        for (const way of ["chooseAgent", "retry", "openTerminal"] as const) {
            expect(talkWayOutKey(way)).toMatch(/^boss\.panel\.talk\./);
        }
    });

    // #2257: talking to him never needs leaving his layer. His terminal is never the main way out of a note; it stays
    // beside it, for whoever wants to look, and only where it has something to show.
    it("never makes his terminal the way out, and keeps it as a secondary action (#2257)", () => {
        const where = { workspaceid: "w", tabid: "t", blockid: "b" };
        const states: TalkState[] = [
            { ...IdleTalk, phase: "failed", reason: "noagent", where },
            { ...IdleTalk, phase: "failed", reason: "notsubmitted", where },
            { ...IdleTalk, phase: "failed", reason: "refused", where },
            { ...IdleTalk, phase: "failed", reason: "humandraft", where },
            { ...IdleTalk, phase: "unread", where },
            { ...IdleTalk, phase: "noreply", where },
            { ...IdleTalk, phase: "needsanswer", where },
            { ...IdleTalk, phase: "busy", where },
            { ...IdleTalk, phase: "queued", where },
        ];
        for (const state of states) {
            expect(talkWayOut(state), JSON.stringify(state)).not.toBe("openTerminal");
        }
        expect(states.filter(talkTerminalAside).map((s) => s.reason || s.phase)).toEqual([
            "noagent",
            "notsubmitted",
            "refused",
            "humandraft",
            "unread",
            "noreply",
            "needsanswer",
        ]);
        expect(talkTerminalAside({ ...IdleTalk, phase: "failed", reason: "refused" })).toBe(false);
        expect(talkWayOut({ ...IdleTalk, phase: "unread" })).toBe("retry");
    });

    // #2257: a busy agent keeps the message, which goes by itself: the field says so, with the domino.
    it("says a queued message goes by itself, with the domino (#2257)", () => {
        const queued = queuedOf(talkStateOf({ status: "busy", reason: "notready" }));
        expect(queued.phase).toBe("queued");
        expect(talkNoteKey(queued)).toBe("boss.panel.talk.queued");
        expect(talkWaits(queued)).toBe(true);
        expect(keepsText(queued)).toBe(true);
        expect(canSend("changed", queued)).toBe(true);
        expect(queuedOf(talkStateOf({ status: "sent" })).phase).toBe("answering");
        for (const texts of [En, Fr]) {
            expect(textAt(texts, "boss.panel.talk.queued")).toMatch(/\{name\}/);
            expect(textAt(texts, "boss.panel.talk.humanDraft")).toMatch(/\{name\}/);
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
        expect(talkTerminalAside(step.state)).toBe(true);
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

// #2155: his agent stopped on a prompt in his hidden terminal (a fake agent state: waiting).
describe("a Brokk blocked on a prompt is no silence (#2155)", () => {
    const answering = talkStateOf({ status: "sent", blockid: "b", tabid: "t", workspaceid: "w" });
    const waitingReply = { status: "waiting" as const };

    it("says he needs the developer's answer and offers his terminal, however long it lasts", () => {
        let step = { state: answering, follow: StartFollow, done: false };
        for (let i = 0; i < IdleReadingsForNoReply * 2; i++) {
            step = followStep(step.state, step.follow, waitingReply, false, true);
        }
        expect(step).toMatchObject({ done: false, state: { phase: "needsanswer" } });
        expect(talkNoteKey(step.state)).toBe("boss.panel.talk.needsAnswer");
        expect(talkTerminalAside(step.state)).toBe(true);
        expect(step.state.where).toEqual({ workspaceid: "w", tabid: "t", blockid: "b" });
        expect(keepsText(step.state)).toBe(false);
    });

    it("keeps what he said before the prompt", () => {
        const reply = { status: "answer" as const, markdown: "Cleaning", blockid: "b", tabid: "t" };
        const step = followStep(answering, StartFollow, reply, false, true);
        expect(step.state).toMatchObject({ phase: "needsanswer", reply: "Cleaning" });
    });

    it("goes back to thinking once his agent works again after the developer answered", () => {
        const blocked = followStep(answering, StartFollow, waitingReply, false, true);
        const resumed = followStep(blocked.state, blocked.follow, waitingReply, true, false);
        expect(resumed).toMatchObject({ done: false, state: { phase: "answering" } });
    });

    it("still says the terminal was closed when it was", () => {
        const step = followStep(answering, StartFollow, { status: "none" }, false, true);
        expect(step).toMatchObject({ done: true, state: { phase: "failed", reason: "gone" } });
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
