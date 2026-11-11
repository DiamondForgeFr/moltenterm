// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The queue every expression Brokk is asked goes through (FR-BOSS-007, AC13, #1959). A person who reacts to everything
// at once is a tic, so one gesture is played at a time, in order of importance, and most of what is asked in a burst is
// folded into one. Pure and driven by the clock it is handed, so the rules are tested without a wait: the model that
// owns it (brokk-expressions.ts) only sets a timer for the moment this asks to be woken.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { AskedExpression, BrokkExpression } from "./brokk-ask-model";

// Most important first: a frown is never given up for a call.
export const ExpressionRank: Record<BrokkExpression, number> = { frown: 0, doubtful: 1, smile: 2, nod: 3, call: 4 };

// How grave an event is for the developer (FR-BOSS-009, AC3). The gravest event waiting for a visit sets the face he
// comes with. It is not the order above: a gesture queue ranks a smile before a call, but in a visit a call (something
// asks for the developer) outranks a smile (good news waits).
export type Severity = "grave" | "important" | "neutre" | "bonne";

export const SeverityRank: Record<Severity, number> = { grave: 3, important: 2, neutre: 1, bonne: 0 };

export const SeverityExpression: Record<Severity, BrokkExpression> = {
    grave: "frown",
    important: "doubtful",
    neutre: "call",
    bonne: "smile",
};

export function severest(severities: Severity[]): Severity {
    let rtn: Severity = null;
    for (const severity of severities) {
        if (rtn == null || SeverityRank[severity] > SeverityRank[rtn]) {
            rtn = severity;
        }
    }
    return rtn;
}

// At least this long between the start of two expressions.
export const MinGapMs = 8000;
// What is asked less than this long after an expression of the same or a higher importance started is folded into it:
// several answers are one nod, an arrival that comes with a failure is the frown's.
export const BurstMs = 10000;
// The same expression at most once in this long (the nod that answers the developer's own action excepted).
export const RepeatMs = 60000;
// No expression starts within this long of a keystroke: he does not wave at someone who is typing.
export const KeyQuietMs = 4000;
// A request that cannot start is dropped after this long (a gesture missed is not replayed); the call waits longer, since
// it is what tells him that something arrived while he types, and then gives up, the badge being enough.
export const WaitLimitMs = 8000;
export const CallWaitLimitMs = 30000;
// A call is given up to a more important expression asked this soon after it started.
export const CallYieldMs = 500;
// A nod that answers the developer waits this long, so that the list being cleared by that very answer makes it a smile.
export const ReplySettleMs = 2000;

// How long each expression plays, as his manifest says (the manifest is the portrait's: a test keeps the two equal, so
// that the bubble's up-front code does not import it).
export const ExpressionMs: Record<BrokkExpression, number> = {
    smile: 3375,
    doubtful: 4625,
    frown: 2625,
    nod: 2750,
    call: 2500,
};

// `answer`: the tone that opens his answer to the developer (FR-BOSS-009, AC88, #2259).
export type QueuedExpression = { expression: BrokkExpression; since: number; reply: boolean; answer?: boolean };

export type QueueState = {
    // The one request that waits for its moment.
    slot: QueuedExpression;
    // The last expression that started, and the last start of each one.
    last: { expression: BrokkExpression; at: number };
    startedAt: Partial<Record<BrokkExpression, number>>;
    lastKeyAt: number;
    // The count of expressions started: the cue the portrait plays again for.
    cue: number;
};

export const EmptyQueue: QueueState = { slot: null, last: null, startedAt: {}, lastKeyAt: null, cue: 0 };

export type QueueEvent =
    // `reply`: the expression answers the developer's own action. `answer`: it is the tone his answer opens with, which
    // the keystroke that sent the message does not hold back, and which may come back within the minute: it follows
    // what he says, not a tic.
    | { type: "ask"; expression: BrokkExpression; reply?: boolean; answer?: boolean }
    | { type: "key" }
    | { type: "tick" };

export type QueueStep = {
    state: QueueState;
    // The expression that starts now.
    play: AskedExpression;
    // When to send a tick, or null when nothing waits.
    wakeAt: number;
};

function sinceMs(at: number, now: number): number {
    return at == null ? Infinity : now - at;
}

function waitLimit(expression: BrokkExpression): number {
    return expression === "call" ? CallWaitLimitMs : WaitLimitMs;
}

// A request refused outright: folded into a burst, or repeated too soon.
function refused(state: QueueState, expression: BrokkExpression, again: boolean, now: number): boolean {
    const last = state.last;
    if (
        last != null &&
        sinceMs(last.at, now) < BurstMs &&
        ExpressionRank[expression] >= ExpressionRank[last.expression]
    ) {
        return true;
    }
    return !again && sinceMs(state.startedAt[expression], now) < RepeatMs;
}

// An expression that follows another one without waiting for the gap: a smile after the nod of the last answer, because
// that answer cleared the list, and any more important expression right after a call, which only got the developer's eye
// when the failure that raised the badge was still to be told.
function upgradesLast(state: QueueState, expression: BrokkExpression, now: number): boolean {
    const last = state.last;
    if (last == null) {
        return false;
    }
    if (last.expression === "call") {
        return ExpressionRank[expression] < ExpressionRank.call && sinceMs(last.at, now) < CallYieldMs;
    }
    return expression === "smile" && last.expression === "nod" && sinceMs(last.at, now) < BurstMs;
}

// The first moment the waiting request can start.
function readyAt(state: QueueState, slot: QueuedExpression): number {
    let at = slot.since;
    if (state.last != null && !upgradesLast(state, slot.expression, slot.since)) {
        at = Math.max(at, state.last.at + MinGapMs);
    }
    // The keys that sent the message do not hold back the tone of his answer; the developer writing again does.
    if (state.lastKeyAt != null && !(slot.answer === true && state.lastKeyAt <= slot.since)) {
        at = Math.max(at, state.lastKeyAt + KeyQuietMs);
    }
    if (slot.reply) {
        at = Math.max(at, slot.since + ReplySettleMs);
    }
    return at;
}

function admitted(
    slot: QueuedExpression,
    request: { expression: BrokkExpression; reply: boolean; answer: boolean },
    now: number
): QueuedExpression {
    if (slot == null || ExpressionRank[request.expression] < ExpressionRank[slot.expression]) {
        const rtn: QueuedExpression = { expression: request.expression, since: now, reply: request.reply };
        if (request.answer) {
            rtn.answer = true;
        }
        return rtn;
    }
    return slot;
}

export function queueAfter(before: QueueState, event: QueueEvent, now: number): QueueStep {
    let state = before;
    if (event.type === "key") {
        state = { ...state, lastKeyAt: now };
    }
    if (event.type === "ask") {
        const reply = event.reply === true;
        const answer = event.answer === true;
        if (!refused(state, event.expression, reply || answer, now)) {
            state = { ...state, slot: admitted(state.slot, { expression: event.expression, reply, answer }, now) };
        }
    }
    if (state.slot != null && now - state.slot.since > waitLimit(state.slot.expression)) {
        state = { ...state, slot: null };
    }
    const slot = state.slot;
    if (slot == null) {
        return { state, play: null, wakeAt: null };
    }
    const ready = readyAt(state, slot);
    const expires = slot.since + waitLimit(slot.expression);
    if (ready > now) {
        return { state, play: null, wakeAt: Math.min(ready, expires + 1) };
    }
    const cue = state.cue + 1;
    return {
        state: {
            ...state,
            slot: null,
            last: { expression: slot.expression, at: now },
            startedAt: { ...state.startedAt, [slot.expression]: now },
            cue,
        },
        play: { expression: slot.expression, cue, at: now },
        wakeAt: null,
    };
}
