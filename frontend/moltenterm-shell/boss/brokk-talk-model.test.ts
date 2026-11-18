// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import En from "../i18n/locales/en.json";
import Fr from "../i18n/locales/fr.json";
import { restingPose } from "./brokk-ask-model";
import { brokkPose } from "./brokk-state-model";
import {
    BrainstormCommand,
    canSend,
    fieldAction,
    fieldAfterSend,
    fieldWithReturned,
    IdleTalk,
    isQuestion,
    keepsText,
    MaxFieldLines,
    MaxMessageLength,
    openQuestion,
    PermissionAsk,
    PermissionKinds,
    permitChoices,
    questionAnswers,
    SendingTalk,
    sendsOnKey,
    sendsOnPick,
    showsCommandHint,
    StartingTalk,
    talkFieldHeight,
    talkNoteKey,
    TalkState,
    talkStateOfWire,
    talkTerminalAside,
    talkWaits,
    talkWayOut,
    talkWayOutKey,
    UnreachableReason,
    withPick,
} from "./brokk-talk-model";

function textAt(texts: unknown, key: string): string {
    return key.split(".").reduce((node: any, part) => node?.[part], texts) as string;
}

// What a message's answer says, as wavesrv words it (pkg/molten/brokksession/talkrules.go talkStateOf): the window
// reads the state it sends.
type SayResult = { status: string; reason?: string; blockid?: string; tabid?: string; workspaceid?: string };

function talkStateOf(result: SayResult): TalkState {
    if (result == null) {
        return talkStateOfWire({ phase: "failed", reason: UnreachableReason });
    }
    const phase = (
        result.status === "sent"
            ? "answering"
            : ["busy", "noagent", "agentmissing"].includes(result.status)
              ? result.status
              : "failed"
    ) as TalkState["phase"];
    const where =
        result.blockid && result.tabid
            ? { workspaceid: result.workspaceid ?? "", tabid: result.tabid, blockid: result.blockid }
            : null;
    return talkStateOfWire({ phase, reason: result.reason, where });
}

describe("what a message does (FR-BOSS-009, AC15)", () => {
    // #2382: the state comes from wavesrv's talk, the same in every window.
    it("reads the state wavesrv's talk sends, and an unanswered call as a failure", () => {
        const state = talkStateOfWire({
            phase: "answering",
            started: true,
            agentname: "Claude Code",
            reply: "Two.",
            where: { workspaceid: "w", tabid: "t", blockid: "b" },
        });
        expect(state).toEqual({
            phase: "answering",
            reason: "",
            agentName: "Claude Code",
            started: true,
            reply: "Two.",
            where: { workspaceid: "w", tabid: "t", blockid: "b" },
        });
        expect(talkStateOfWire({ phase: "idle" })).toEqual(IdleTalk);
        expect(
            talkStateOfWire({ phase: "queued", where: { workspaceid: "", tabid: "", blockid: "" } }).where
        ).toBeNull();
        expect(talkStateOfWire(null)).toMatchObject({ phase: "failed", reason: UnreachableReason });
        expect(talkStateOfWire({} as any)).toMatchObject({ phase: "failed", reason: UnreachableReason });
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
        expect(talkNoteKey(talkStateOf({ status: "busy" }))).toBe("boss.panel.talk.refusedWhileFree");
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
            [{ status: "failed", reason: "humandraft", ...where }, "boss.panel.talk.humanDraft", "clearAndSend"],
            [{ status: "failed", reason: "unknownprompt", ...where }, "boss.panel.talk.unknownPrompt", "clearAndSend"],
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
        expect(new Set(causes.map(([, key]) => key)).size).toBe(11);
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
        for (const way of ["chooseAgent", "retry", "openTerminal", "clearAndSend"] as const) {
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
            { ...IdleTalk, phase: "failed", reason: "unknownprompt", where },
            { ...IdleTalk, phase: "unread", where },
            { ...IdleTalk, phase: "noreply", where },
            { ...IdleTalk, phase: "needsanswer", where },
            { ...IdleTalk, phase: "busy", reason: "unsettled", where },
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
            "unknownprompt",
            "unread",
            "noreply",
            "needsanswer",
            "unsettled",
        ]);
        expect(talkTerminalAside({ ...IdleTalk, phase: "failed", reason: "refused" })).toBe(false);
        expect(talkWayOut({ ...IdleTalk, phase: "unread" })).toBe("retry");
        // Text MoltenTerm did not type leaves his prompt only by the developer's own click.
        expect(talkWayOut({ ...IdleTalk, phase: "failed", reason: "unknownprompt", where })).toBe("clearAndSend");
        expect(talkWayOut({ ...IdleTalk, phase: "failed", reason: "humandraft", where })).toBe("clearAndSend");
    });

    // #2257: `/brainstorm` is the field's own command, read only where the gate allows the brainstorm.
    it("reads /brainstorm and its idea, only where the brainstorm exists (#2257)", () => {
        expect(fieldAction("/brainstorm", true)).toEqual({ kind: "brainstorm", idea: "" });
        expect(fieldAction("  /Brainstorm   a safe video app\nfor kids  ", true)).toEqual({
            kind: "brainstorm",
            idea: "a safe video app\nfor kids",
        });
        expect(fieldAction("let's /brainstorm", true)).toEqual({ kind: "say", text: "let's /brainstorm" });
        // Review: a text starting with a slash never goes, where his agent would run it as its own command; on rc and
        // public /brainstorm is one of those, and nothing offers it.
        expect(fieldAction("/brainstorming is fun", true)).toEqual({ kind: "slash" });
        expect(fieldAction("/brainstorm an idea", false)).toEqual({ kind: "slash" });
        expect(fieldAction("  /clear", true)).toEqual({ kind: "slash" });
        expect(showsCommandHint("/br", false)).toBe(false);
        expect(showsCommandHint("/", true)).toBe(true);
        expect(showsCommandHint("/br", true)).toBe(true);
        expect(showsCommandHint("/brainstorm an idea", true)).toBe(true);
        expect(showsCommandHint("/clear", true)).toBe(false);
        expect(showsCommandHint("hello", true)).toBe(false);
        expect(BrainstormCommand).toBe("/brainstorm");
        for (const texts of [En, Fr]) {
            expect(textAt(texts, "boss.panel.talk.commandHint")).toMatch(/^\/brainstorm .*\{name\}/);
            expect(textAt(texts, "boss.panel.talk.keysBrainstorm")).toContain("/brainstorm");
        }
    });

    // #2257: a busy agent keeps the message, which goes by itself: the field says so, with the domino.
    it("says a queued message goes by itself, with the domino (#2257)", () => {
        const queued: TalkState = { ...IdleTalk, phase: "queued", reason: "notready" };
        expect(talkNoteKey(queued)).toBe("boss.panel.talk.queued");
        expect(talkWaits(queued)).toBe(true);
        expect(keepsText(queued)).toBe(false);
        expect(canSend("changed", queued)).toBe(true);
        for (const texts of [En, Fr]) {
            expect(textAt(texts, "boss.panel.talk.queued")).toMatch(/\{name\}/);
            expect(textAt(texts, "boss.panel.talk.humanDraft")).toMatch(/\{name\}/);
        }
    });

    // #2284: the waiting message leaves the field; what is sent meanwhile joins it; a cancel gives it back first.
    it("gives a waiting message back before what was written meanwhile (#2284)", () => {
        expect(fieldWithReturned("first", "")).toBe("first");
        expect(fieldWithReturned("first", "  ")).toBe("first");
        expect(fieldWithReturned("first", "more")).toBe("first\nmore");
        for (const texts of [En, Fr]) {
            expect(textAt(texts, "boss.panel.talk.queuedRow")).toMatch(/\{name\}/);
            expect(textAt(texts, "boss.panel.talk.refusedWhileFree")).toMatch(/\{name\}/);
            expect(textAt(texts, "boss.panel.talk.cancelQueued")).toBeTruthy();
        }
    });

    // Review of #2257: an agent that never comes to rest is waited for a short while, then said plainly.
    it("says plainly when his agent never came to rest (#2257)", () => {
        const unsettled = talkStateOf({ status: "busy", reason: "unsettled" });
        expect(talkNoteKey(unsettled)).toBe("boss.panel.talk.unsettled");
        expect(talkNoteKey(talkStateOf({ status: "busy" }))).toBe("boss.panel.talk.refusedWhileFree");
    });

    // #2257: the answers a permission request offers, always allow only when his agent offers it; the approvals made
    // without asking show each once.
    it("offers always allow only when his agent does, and words every kind of request (#2257, #2382)", () => {
        const ask = { id: "r", blockid: "b", tool: "Bash", kind: "command" as const, subject: "ls", at: 1 };
        expect(permitChoices(ask)).toEqual(["allow", "deny"]);
        expect(permitChoices({ ...ask, always: true })).toEqual(["allow", "always", "deny"]);
        expect(PermissionKinds).toEqual(expect.arrayContaining(["find", "grep", "tool"]));
        for (const kind of PermissionKinds) {
            for (const texts of [En, Fr]) {
                expect(textAt(texts, `boss.panel.talk.permission.kind.${kind}`)).toMatch(/\{name\}.*:$/);
            }
        }
    });

    // Review of #2257: the field empties only when it still holds what was sent.
    it("keeps what the developer wrote while a message waited (#2257)", () => {
        const taken = talkStateOf({ status: "sent" });
        expect(fieldAfterSend("an idea", "an idea", taken)).toBe("");
        expect(fieldAfterSend("an idea", "an idea, for kids", taken)).toBe("an idea, for kids");
        expect(fieldAfterSend("an idea", "an idea", talkStateOf({ status: "busy" }))).toBe("an idea");
    });
});

// #2155: his agent waits on a prompt only his terminal shows: the window says so, with his terminal beside it.
describe("a Brokk blocked on a prompt is no silence (#2155)", () => {
    it("says he needs the developer's answer and offers his terminal as a secondary link", () => {
        const where = { workspaceid: "w", tabid: "t", blockid: "b" };
        const blocked: TalkState = { ...IdleTalk, phase: "needsanswer", where };
        expect(talkNoteKey(blocked)).toBe("boss.panel.talk.needsAnswer");
        expect(talkTerminalAside(blocked)).toBe(true);
        expect(talkWayOut(blocked)).toBeNull();
        expect(keepsText(blocked)).toBe(false);
    });
});

// #2382 (AC100): his agent's question, answered in the window: a choice at once, several with Send, or the composer.
describe("his agent's questions (AC100, #2382)", () => {
    const ask: PermissionAsk = {
        id: "q-1",
        blockid: "b",
        tool: "AskUserQuestion",
        kind: "question",
        subject: "Where?",
        at: 1,
        questions: [
            {
                question: "Where are the projects?",
                header: "Folder",
                options: [{ label: "Documents" }, { label: "Elsewhere" }],
            },
        ],
    };
    const two: PermissionAsk = {
        ...ask,
        questions: [
            ...ask.questions,
            { question: "Which ones?", options: [{ label: "All" }, { label: "Active" }], multiselect: true },
        ],
    };

    it("answers a question of one choice at once", () => {
        expect(isQuestion(ask)).toBe(true);
        expect(isQuestion({ ...ask, kind: "command" })).toBe(false);
        expect(isQuestion({ ...ask, questions: [] })).toBe(false);
        const picked = withPick({}, ask.questions[0], "Documents");
        expect(sendsOnPick(ask, ask.questions[0], picked)).toBe(true);
        expect(questionAnswers(ask, picked)).toEqual({ "Where are the projects?": "Documents" });
        expect(withPick(picked, ask.questions[0], "Elsewhere")).toEqual({ "Where are the projects?": ["Elsewhere"] });
    });

    it("toggles several choices, and waits for every question before the answers go", () => {
        let picks = withPick({}, two.questions[0], "Documents");
        expect(questionAnswers(two, picks)).toBeNull();
        expect(openQuestion(two, picks)?.question).toBe("Which ones?");
        picks = withPick(picks, two.questions[1], "All");
        picks = withPick(picks, two.questions[1], "Active");
        expect(sendsOnPick(two, two.questions[1], picks)).toBe(false);
        expect(questionAnswers(two, picks)).toEqual({
            "Where are the projects?": "Documents",
            "Which ones?": "All, Active",
        });
        picks = withPick(picks, two.questions[1], "All");
        expect(picks["Which ones?"]).toEqual(["Active"]);
        expect(openQuestion(two, picks)).toBeNull();
    });

    it("takes the composer's text as the answer to the first open question", () => {
        expect(openQuestion(ask, {})?.question).toBe("Where are the projects?");
        const typed = { "Where are the projects?": ["In the work folder"] };
        expect(questionAnswers(ask, typed)).toEqual({ "Where are the projects?": "In the work folder" });
        for (const texts of [En, Fr]) {
            expect(textAt(texts, "boss.panel.talk.question.placeholder")).toMatch(/\{name\}/);
            expect(textAt(texts, "boss.panel.talk.question.asks")).toMatch(/\{name\}/);
            expect(textAt(texts, "boss.panel.talk.question.yours")).toMatch(/\{answer\}/);
            for (const key of ["label", "hint", "send", "answering"]) {
                expect(textAt(texts, `boss.panel.talk.question.${key}`), key).toMatch(/\S/);
            }
        }
    });

    // AC102: the placeholder carries what the empty window used to say.
    it("lets the placeholder say what to write", () => {
        expect(textAt(En, "boss.panel.talk.placeholder")).toBe("Tell {name} what you need…");
        expect(textAt(Fr, "boss.panel.talk.placeholder")).toBe("Dites à {name} ce dont vous avez besoin…");
        expect(textAt(En, "boss.panel.talk.empty")).toBeUndefined();
        expect(textAt(En, "boss.panel.talk.hint")).toBeUndefined();
    });
});

describe("his face with the field (FR-BOSS-009, AC9; FR-BOSS-007)", () => {
    const open = { working: 0, waiting: 0, cardOpen: true };

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
