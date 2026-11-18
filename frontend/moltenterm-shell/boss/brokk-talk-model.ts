// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The field at the foot of Brokk's panel (FR-BOSS-009, AC9 and AC15, #2003): what a message does and what the field says
// about it. Pure, so the rules are tested without a window or a session. The rules of the way of a message (its follow,
// its queue) are wavesrv's since #2382 (pkg/molten/brokksession/talkrules.go): every window shows the same talk.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

// must match PermissionAsk and AutoApproval in pkg/molten/brokksession/permit.go
export type PermissionKind =
    | "command"
    | "edit"
    | "write"
    | "read"
    | "fetch"
    | "search"
    | "patch"
    | "find"
    | "grep"
    | "tool"
    | "question";

// A question of his agent to the developer (AskUserQuestion, AC100, #2382), with its choices.
export type AgentChoice = { label: string; description?: string };
export type AgentQuestion = { question: string; header?: string; options: AgentChoice[]; multiselect?: boolean };

export type PermissionAsk = {
    id: string;
    blockid: string;
    agent?: string;
    tool: string;
    kind: PermissionKind;
    subject: string;
    always?: boolean;
    at: number;
    questions?: AgentQuestion[];
};

export type AutoApproval = { id: string; kind: PermissionKind; subject: string; at: number };

// must match the Permit… decisions and results of pkg/molten/brokksession/permit.go
export type PermitDecision = "allow" | "always" | "deny";
export type PermitStatus = "answered" | "gone" | "invalid";

// The permission kinds a card words; a question has a card of its own.
export const PermissionKinds: PermissionKind[] = [
    "command",
    "edit",
    "write",
    "read",
    "fetch",
    "search",
    "patch",
    "find",
    "grep",
    "tool",
];

// The decisions the card offers: always allow only when his agent offers it (#2257).
export function permitChoices(ask: PermissionAsk): PermitDecision[] {
    return ask?.always ? ["allow", "always", "deny"] : ["allow", "deny"];
}

export function isQuestion(ask: PermissionAsk): boolean {
    return ask?.kind === "question" && (ask.questions?.length ?? 0) > 0;
}

// The developer's answers to a question so far, by the question's text: a choice's label, several joined by ", " (the
// question tool's own form), or what was written in the composer.
export type QuestionPicks = Record<string, string[]>;

// The first question still without an answer; the composer's text answers it (AC100). Null when all have one.
export function openQuestion(ask: PermissionAsk, picks: QuestionPicks): AgentQuestion {
    return ask?.questions?.find((q) => (picks[q.question]?.length ?? 0) === 0) ?? null;
}

// A click on a choice: one choice answers its question, several toggle.
export function withPick(picks: QuestionPicks, question: AgentQuestion, label: string): QuestionPicks {
    const current = picks[question.question] ?? [];
    if (!question.multiselect) {
        return { ...picks, [question.question]: [label] };
    }
    const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
    return { ...picks, [question.question]: next };
}

// The answers to send once every question has one; null while one is still open.
export function questionAnswers(ask: PermissionAsk, picks: QuestionPicks): Record<string, string> {
    if (!isQuestion(ask) || openQuestion(ask, picks) != null) {
        return null;
    }
    const rtn: Record<string, string> = {};
    for (const q of ask.questions) {
        rtn[q.question] = picks[q.question].join(", ");
    }
    return rtn;
}

// A pick goes at once when it completes the answers with a choice of a question that takes one (AC100); a question
// with several choices waits for Send.
export function sendsOnPick(ask: PermissionAsk, question: AgentQuestion, picks: QuestionPicks): boolean {
    return !question.multiselect && questionAnswers(ask, picks) != null;
}

export const MaxMessageLength = 4000;

// The field grows with the message up to this many lines, then scrolls inside itself (FR-BOSS-009, AC22b, #2237).
export const MaxFieldLines = 6;

// The field's height for a text that needs `scrollHeight` px: its own lines, at least one, at most MaxFieldLines.
// `padding`: the field's padding above and below together.
export function talkFieldHeight(scrollHeight: number, lineHeight: number, padding: number): number {
    const least = lineHeight + padding;
    const most = MaxFieldLines * lineHeight + padding;
    return Math.min(most, Math.max(least, scrollHeight));
}

// `/brainstorm` in his field starts the brainstorm at once, `/brainstorm <idea>` with that idea at the centre
// (FR-BOSS-010, #2257). It is the field's own command, never an agent's: no terminal and no top field reads it, and
// nothing is installed in his agent for it. Where the gate is shut (rc, public), the field neither offers nor reads it:
// like any text starting with a slash, it stays in the field with a note, never sent for his agent to run.
export const BrainstormCommand = "/brainstorm";

// The command in the field's text, with the idea after it ("" for none); null when the text is not the command.
export function brainstormCommand(text: string): { idea: string } {
    const match = /^\/brainstorm(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (match == null) {
        return null;
    }
    return { idea: (match[1] ?? "").trim() };
}

// What the field does with its text: start the brainstorm (only where the gate allows it), keep a text that starts
// with a slash (his agent would run it as one of its own commands: /clear would wipe his session), or give the text
// to him (review of #2257).
export type FieldAction = { kind: "brainstorm"; idea: string } | { kind: "slash" } | { kind: "say"; text: string };

export function fieldAction(text: string, brainstormAllowed: boolean): FieldAction {
    const command = brainstormAllowed ? brainstormCommand(text) : null;
    if (command != null) {
        return { kind: "brainstorm", idea: command.idea };
    }
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
        return { kind: "slash" };
    }
    return { kind: "say", text: trimmed };
}

// The hint of the command while the developer starts a slash in the field.
export function showsCommandHint(text: string, allowed: boolean): boolean {
    if (!allowed) {
        return false;
    }
    const trimmed = text.trimStart();
    return trimmed.startsWith("/") && BrainstormCommand.startsWith(trimmed.toLowerCase().split(/\s/)[0]);
}

// Enter sends; Shift+Enter makes a new line, and so does Enter while an input method composes a word (#2237).
export function sendsOnKey(key: { key: string; shiftKey?: boolean; isComposing?: boolean }): boolean {
    return key.key === "Enter" && !key.shiftKey && !key.isComposing;
}

// must match the Phase… constants of pkg/molten/brokksession/talkrules.go. idle: nothing to say; starting: the first
// message starts his session; sending: on its way; answering: his agent has it and works on it (reply: what he answered
// so far); answered: his answer is here; unread: he answered where the window cannot read it; noreply: no answer came;
// needsanswer: his agent waits for the developer, on a request or a question his window shows, or on a prompt only his
// terminal can show. The others are the failures of the message. queued: his agent was busy, and the message goes by
// itself once he is free (#2257).
export type TalkPhase =
    | "idle"
    | "starting"
    | "sending"
    | "queued"
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

// The reason of a call wavesrv did not answer (refused, timed out, no route), and of the talk's ReasonUnreachable.
export const UnreachableReason = "unreachable";

// TalkState as wavesrv sends it (pkg/molten/brokksession/talkrules.go).
export type TalkStateWire = {
    phase: TalkPhase;
    reason?: string;
    agentname?: string;
    started?: boolean;
    reply?: string;
    where?: TalkWhere;
};

export function talkStateOfWire(wire: TalkStateWire): TalkState {
    if (wire?.phase == null) {
        return { ...IdleTalk, phase: "failed", reason: UnreachableReason };
    }
    return {
        phase: wire.phase,
        reason: wire.reason ?? "",
        agentName: wire.agentname ?? "",
        started: wire.started === true,
        reply: wire.reply ?? "",
        where: wire.where?.blockid ? wire.where : null,
    };
}

// Each cause of a failure has its own note (#2236): one note for all of them said "unreachable" when his terminal had
// only refused a long message. The reasons are pkg/molten/brokksession/session.go's, and the window's UnreachableReason.
const FailedNoteKeys = new Map<string, string>([
    ["gone", "boss.panel.talk.gone"],
    ["notsubmitted", "boss.panel.talk.notSubmitted"],
    ["humandraft", "boss.panel.talk.humanDraft"],
    ["unknownprompt", "boss.panel.talk.unknownPrompt"],
    ["noagent", "boss.panel.talk.agentStopped"],
    ["refused", "boss.panel.talk.refused"],
    ["terminal", "boss.panel.talk.noTerminal"],
    ["nospace", "boss.panel.talk.noSpace"],
    ["notext", "boss.panel.talk.noText"],
    ["lookup", "boss.panel.talk.lookupFailed"],
    [UnreachableReason, "boss.panel.talk.unreachable"],
]);

// A message goes when it has text, fits, and the previous one is not on its way.
export function canSend(text: string, state: TalkState): boolean {
    const trimmed = text.trim();
    return trimmed !== "" && trimmed.length <= MaxMessageLength && !onItsWay(state);
}

export function onItsWay(state: TalkState): boolean {
    return state.phase === "sending" || state.phase === "starting";
}

// The text leaves the field once the agent has it, or once it waits for him in his talk window (queued, #2284): a
// missing agent or a failure keep it for another try.
export function keepsText(state: TalkState): boolean {
    return !(
        state.phase === "queued" ||
        state.phase === "answering" ||
        state.phase === "needsanswer" ||
        state.phase === "answered" ||
        state.phase === "unread" ||
        state.phase === "noreply"
    );
}

// The domino turns while the developer waits for him.
export function talkWaits(state: TalkState): boolean {
    return onItsWay(state) || state.phase === "answering" || state.phase === "queued";
}

// The message waiting for him in his talk window (#2284); several sent meanwhile join it, one per paragraph.
export type QueuedMessage = { text: string; since: number };

// The text a queued message gives back to the field (Cancel, or a failure): before what the developer wrote meanwhile.
export function fieldWithReturned(returned: string, current: string): string {
    if (current.trim() === "") {
        return returned;
    }
    return `${returned}\n${current}`;
}

// The line under the field, as an interface key; null says nothing.
export function talkNoteKey(state: TalkState): string {
    switch (state.phase) {
        case "starting":
            return "boss.panel.talk.starting";
        case "sending":
            return "boss.panel.talk.sending";
        case "queued":
            return "boss.panel.talk.queued";
        case "answering":
            return "boss.panel.talk.thinking";
        case "needsanswer":
            return "boss.panel.talk.needsAnswer";
        case "unread":
            return "boss.panel.talk.unread";
        case "noreply":
            return "boss.panel.talk.noReply";
        case "busy":
            return state.reason === "unsettled" ? "boss.panel.talk.unsettled" : "boss.panel.talk.refusedWhileFree";
        case "noagent":
            return "boss.panel.talk.noAgent";
        case "agentmissing":
            return "boss.panel.talk.agentMissing";
        case "failed":
            return FailedNoteKeys.get(state.reason) ?? "boss.panel.talk.unreachable";
        default:
            return null;
    }
}

export type TalkWayOut = "chooseAgent" | "retry" | "openTerminal" | "clearAndSend";

// The main way out of a failure: no failure is left without one (#2028), and his terminal is never it (#2257): talking
// to him never needs leaving his layer. The terminal stays a secondary action (talkTerminalAside). Text in his prompt
// that MoltenTerm did not type is never cleared but by the developer's own click (clearAndSend).
export function talkWayOut(state: TalkState): TalkWayOut {
    switch (state.phase) {
        case "noagent":
        case "agentmissing":
            return "chooseAgent";
        case "busy":
            return "retry";
        case "failed":
            return state.reason === "unknownprompt" || state.reason === "humandraft" ? "clearAndSend" : "retry";
        case "unread":
        case "noreply":
            // His answer is only in his terminal (beside), and the field takes the next message: retrying is for when
            // his terminal cannot even be shown.
            return state.where != null ? null : "retry";
        default:
            return null;
    }
}

// His terminal, offered beside the main way out for whoever wants to look (#2257): where the answer is only there, his
// agent waits on a prompt there, or the cause of a failure shows there.
export function talkTerminalAside(state: TalkState): boolean {
    if (state.where == null) {
        return false;
    }
    switch (state.phase) {
        case "needsanswer":
        case "unread":
        case "noreply":
            return true;
        case "busy":
            return state.reason === "unsettled";
        case "failed":
            return (
                state.reason === "noagent" ||
                state.reason === "notsubmitted" ||
                state.reason === "refused" ||
                state.reason === "humandraft" ||
                state.reason === "unknownprompt"
            );
        default:
            return false;
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
        case "clearAndSend":
            return "boss.panel.talk.clearAndSend";
        default:
            return null;
    }
}

// What is left in the field once a message has gone (review of #2257): the field empties only when it still holds
// what was sent; text the developer wrote meanwhile (while a queued try was on its way) stays.
export function fieldAfterSend(sent: string, current: string, result: TalkState): string {
    if (keepsText(result) || current.trim() !== sent.trim()) {
        return current;
    }
    return "";
}

// What his face does with the conversation is brokk-speech-model.ts talkFace (FR-BOSS-009, AC86, AC87, #2259).
