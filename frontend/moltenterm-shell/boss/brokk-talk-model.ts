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

// must match PermissionAsk and AutoApproval in pkg/molten/brokksession/permit.go
export type PermissionKind = "command" | "edit" | "write" | "read" | "fetch" | "search" | "patch";

export type PermissionAsk = {
    id: string;
    blockid: string;
    agent?: string;
    tool: string;
    kind: PermissionKind;
    subject: string;
    always?: boolean;
    at: number;
};

export type AutoApproval = { id: string; kind: PermissionKind; subject: string; at: number };

// must match the Permit… decisions and results of pkg/molten/brokksession/permit.go
export type PermitDecision = "allow" | "always" | "deny";
export type PermitStatus = "answered" | "gone" | "invalid";

export const PermissionKinds: PermissionKind[] = ["command", "edit", "write", "read", "fetch", "search", "patch"];

// The decisions the card offers: always allow only when his agent offers it (#2257).
export function permitChoices(ask: PermissionAsk): PermitDecision[] {
    return ask?.always ? ["allow", "always", "deny"] : ["allow", "deny"];
}

// The approvals of the latest reading added to those shown, each once, in their order.
export function withApprovals(shown: AutoApproval[], read: AutoApproval[]): AutoApproval[] {
    if (read == null || read.length === 0) {
        return shown;
    }
    const known = new Set(shown.map((a) => a.id));
    const added = read.filter((a) => a?.id && !known.has(a.id));
    return added.length === 0 ? shown : [...shown, ...added];
}

export type ReplyResult = {
    permission?: PermissionAsk;
    approved?: AutoApproval[];
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

// idle: nothing to say; starting: the first message starts his session; sending: on its way; answering: his agent has
// it and works on it (reply: what he answered so far); answered: his answer is here; unread: he answered in his
// terminal, where the panel cannot read it; noreply: no answer came; needsanswer: his agent stopped on a prompt in his
// hidden terminal (a permission, a trust question) and waits for the developer there. The others are the failures of
// the message. queued: his agent was busy, and the message goes by itself once he is free (#2257).
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

export function whereOf(result: { blockid?: string; tabid?: string; workspaceid?: string }): TalkWhere {
    if (!result?.blockid || !result?.tabid) {
        return null;
    }
    return { workspaceid: result.workspaceid ?? "", tabid: result.tabid, blockid: result.blockid };
}

// The reason of a call wavesrv did not answer (refused, timed out, no route): the window's own, never one of
// pkg/molten/brokksession/session.go.
export const UnreachableReason = "unreachable";

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
        reason: result == null ? UnreachableReason : (result.reason ?? ""),
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
    return onItsWay(state) || state.phase === "answering" || state.phase === "queued";
}

// A message his agent was too busy to take waits for him (#2257): it is tried again this often while he is free, for
// at most this long, then the field offers to try again.
export const QueueEveryMs = 2000;
export const MaxQueueMs = 10 * 60 * 1000;
// An agent whose state cannot be read (no hooks) and whose transcript never shows it at rest (a call or a turn whose end
// never came) is waited for this long only, then the field says so plainly (review of #2257).
export const MaxUnsettledQueueMs = 2 * 60 * 1000;

// How long a message waits for him in the field, by what kept him busy.
export function queueBoundMs(state: TalkState): number {
    return state.reason === "unsettled" ? MaxUnsettledQueueMs : MaxQueueMs;
}

// What a busy answer becomes while the message waits for him: the field keeps the text and says it goes by itself.
export function queuedOf(state: TalkState): TalkState {
    return state.phase === "busy" ? { ...state, phase: "queued" } : state;
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
            return state.reason === "unsettled" ? "boss.panel.talk.unsettled" : "boss.panel.talk.busy";
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
