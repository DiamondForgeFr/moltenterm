// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { BrokkExpression } from "./brokk-ask-model";
import {
    BurstMs,
    CallWaitLimitMs,
    EmptyQueue,
    ExpressionMs,
    ExpressionRank,
    KeyQuietMs,
    MinGapMs,
    queueAfter,
    QueueEvent,
    QueueState,
    RepeatMs,
    ReplySettleMs,
    severest,
    Severity,
    SeverityExpression,
    SeverityRank,
    WaitLimitMs,
} from "./brokk-queue";
import Manifest from "./portrait/brokk/brokk-manifest.json";

// The queue is driven by a clock the test moves by hand: nothing here waits for real time.
function drive() {
    const world = {
        state: EmptyQueue as QueueState,
        played: [] as { expression: BrokkExpression; at: number }[],
        wakeAt: null as number,
        step(event: QueueEvent, at: number) {
            const step = queueAfter(world.state, event, at);
            world.state = step.state;
            world.wakeAt = step.wakeAt;
            if (step.play != null) {
                world.played.push({ expression: step.play.expression, at });
            }
            return step;
        },
        ask(expression: BrokkExpression, at: number, reply = false) {
            return world.step({ type: "ask", expression, reply }, at);
        },
        // The clock reaches the moment the queue asked to be woken at.
        wake() {
            expect(world.wakeAt).not.toBeNull();
            return world.step({ type: "tick" }, world.wakeAt);
        },
        names: () => world.played.map((p) => p.expression),
    };
    return world;
}

describe("the expression queue (FR-BOSS-007, AC13)", () => {
    it("keeps the lengths of the gestures the manifest holds, without importing it", () => {
        expect(ExpressionMs).toEqual(Manifest.expressionMs);
    });

    it("ranks the expressions: frown, doubtful, smile, nod, call", () => {
        const order = Object.keys(ExpressionRank).sort(
            (a, b) => ExpressionRank[a as BrokkExpression] - ExpressionRank[b as BrokkExpression]
        );
        expect(order).toEqual(["frown", "doubtful", "smile", "nod", "call"]);
    });

    it("starts the first request at once, with a cue of its own", () => {
        const q = drive();
        const step = q.ask("frown", 1000);
        expect(step.play).toEqual({ expression: "frown", cue: 1, at: 1000 });
        expect(step.wakeAt).toBeNull();
    });

    it("keeps one place: a more important request replaces the one waiting, a lesser one is folded into it", () => {
        const q = drive();
        q.ask("call", 0);
        // The gap holds the next ones back; a nod is more important than the call that just played.
        q.ask("nod", 1000);
        expect(q.state.slot?.expression).toBe("nod");
        q.ask("doubtful", 2000);
        expect(q.state.slot?.expression).toBe("doubtful");
        q.ask("smile", 3000);
        expect(q.state.slot?.expression).toBe("doubtful");
        q.ask("call", 3500);
        q.ask("nod", 4000);
        expect(q.state.slot?.expression).toBe("doubtful");
        q.wake();
        expect(q.names()).toEqual(["call", "doubtful"]);
        expect(q.state.slot).toBeNull();
    });

    it("folds into an expression that just started the requests that are no more important than it", () => {
        const q = drive();
        q.ask("smile", 0);
        q.ask("nod", 1000);
        q.ask("call", 2000);
        q.ask("smile", 3000);
        expect(q.state.slot).toBeNull();
        const more = q.ask("frown", 4000);
        expect(more.wakeAt).toBe(MinGapMs);
        expect(q.state.slot?.expression).toBe("frown");
    });

    it("leaves at least 8 s between two expressions, and wakes at the moment the next may start", () => {
        const q = drive();
        q.ask("nod", 0);
        const waiting = q.ask("frown", 1000);
        expect(waiting.play).toBeNull();
        expect(waiting.wakeAt).toBe(MinGapMs);
        expect(q.step({ type: "tick" }, MinGapMs - 1).play).toBeNull();
        q.wake();
        expect(q.played).toEqual([
            { expression: "nod", at: 0 },
            { expression: "frown", at: MinGapMs },
        ]);
    });

    it("folds a burst into one: several answers are one nod, a call that comes with the same kind is one call", () => {
        const q = drive();
        q.ask("nod", 0);
        q.ask("nod", 2000, true);
        q.ask("nod", BurstMs - 1, true);
        q.ask("call", 100);
        q.ask("call", 5000);
        expect(q.state.slot).toBeNull();
        expect(q.names()).toEqual(["nod"]);
    });

    it("plays the nod of a later answer, once the burst is over, though a nod played less than a minute ago", () => {
        const q = drive();
        q.ask("nod", 0, true);
        q.wake();
        expect(q.names()).toEqual(["nod"]);
        q.ask("nod", ReplySettleMs + BurstMs + 1000, true);
        q.wake();
        expect(q.names()).toEqual(["nod", "nod"]);
    });

    it("holds an answer's nod a beat, so that the list cleared by that answer makes it a smile instead", () => {
        const q = drive();
        const step = q.ask("nod", 0, true);
        expect(step.play).toBeNull();
        expect(step.wakeAt).toBe(ReplySettleMs);
        q.ask("smile", 1000);
        expect(q.names()).toEqual(["smile"]);
        expect(q.state.slot).toBeNull();
        // The nod is gone, not delayed: nothing plays at the end of the beat.
        expect(q.step({ type: "tick" }, ReplySettleMs).play).toBeNull();
        expect(q.names()).toEqual(["smile"]);
    });

    it("lets the smile of a cleared list follow the nod that just played, without the gap", () => {
        const q = drive();
        q.ask("nod", 0, true);
        q.wake();
        q.ask("smile", ReplySettleMs + 500);
        expect(q.names()).toEqual(["nod", "smile"]);
        expect(q.played[1].at).toBe(ReplySettleMs + 500);
    });

    it("lets a smile follow only a nod, not another expression, without the gap", () => {
        const q = drive();
        q.ask("call", 0);
        const step = q.ask("smile", 1000);
        expect(step.play).toBeNull();
        expect(step.wakeAt).toBe(MinGapMs);
    });

    it("plays the same expression at most once a minute, the nod that answers the developer excepted", () => {
        const q = drive();
        q.ask("smile", 0);
        q.ask("doubtful", 20000);
        q.ask("smile", 40000);
        expect(q.state.slot).toBeNull();
        expect(q.names()).toEqual(["smile", "doubtful"]);
        q.ask("smile", RepeatMs + 1);
        expect(q.names()).toEqual(["smile", "doubtful", "smile"]);
        q.ask("nod", 100000);
        q.ask("nod", 120000);
        expect(q.state.slot).toBeNull();
        expect(q.names().filter((name) => name === "nod")).toEqual(["nod"]);
        q.ask("nod", 150000, true);
        q.wake();
        expect(q.names().filter((name) => name === "nod")).toEqual(["nod", "nod"]);
    });

    it("gives the call up to a frown asked with it, whichever comes first", () => {
        const first = drive();
        first.ask("frown", 0);
        first.ask("call", 100);
        expect(first.names()).toEqual(["frown"]);
        expect(first.state.slot).toBeNull();

        const second = drive();
        second.ask("call", 0);
        second.ask("frown", 100);
        expect(second.names()).toEqual(["call", "frown"]);
        expect(second.played[1].at).toBe(100);
    });

    it("starts no expression within 4 s of a keystroke, and waits for the pause", () => {
        const q = drive();
        q.step({ type: "key" }, 0);
        const waiting = q.ask("frown", 1000);
        expect(waiting.play).toBeNull();
        expect(waiting.wakeAt).toBe(KeyQuietMs);
        q.step({ type: "key" }, 3000);
        expect(q.wakeAt).toBe(3000 + KeyQuietMs);
        q.wake();
        expect(q.played).toEqual([{ expression: "frown", at: 3000 + KeyQuietMs }]);
    });

    it("drops what waited too long behind the typing: a missed gesture is not played later", () => {
        const q = drive();
        q.ask("nod", 0);
        q.step({ type: "key" }, 0);
        q.ask("smile", 3000);
        for (let at = 3000; at <= 3000 + WaitLimitMs; at += 3000) {
            q.step({ type: "key" }, at);
        }
        expect(q.wakeAt).not.toBeNull();
        q.wake();
        expect(q.state.slot).toBeNull();
        expect(q.names()).toEqual(["nod"]);
    });

    it("lets the call wait much longer behind the typing, then gives up: the badge is enough", () => {
        const waits = drive();
        waits.step({ type: "key" }, 0);
        waits.ask("call", 100);
        waits.step({ type: "key" }, 20000);
        waits.wake();
        expect(waits.played).toEqual([{ expression: "call", at: 20000 + KeyQuietMs }]);

        const typing = drive();
        typing.step({ type: "key" }, 0);
        typing.ask("call", 100);
        typing.step({ type: "key" }, CallWaitLimitMs - 1000);
        typing.wake();
        expect(typing.played).toEqual([]);
        expect(typing.state.slot).toBeNull();
    });

    it("counts a cue for each expression started, so that the same gesture twice plays twice", () => {
        const q = drive();
        q.ask("smile", 0);
        q.ask("smile", RepeatMs + 1);
        expect(q.state.cue).toBe(2);
    });

    it("never starts what it was not asked", () => {
        const q = drive();
        expect(q.step({ type: "tick" }, 5000).play).toBeNull();
        expect(q.step({ type: "key" }, 5000).play).toBeNull();
        expect(q.wakeAt).toBeNull();
    });
});

// FR-BOSS-009, AC88 (#2259): the tone his answer opens with.
describe("the tone of his answer in the queue (AC88)", () => {
    const answer = (expression: BrokkExpression): QueueEvent => ({ type: "ask", expression, answer: true });

    it("is not held back by the keys that sent the message", () => {
        const q = drive();
        q.step({ type: "key" }, 0);
        const step = q.step(answer("smile"), 3000);
        expect(step.play).toMatchObject({ expression: "smile", at: 3000 });
    });

    it("waits while the developer writes again, as any expression does", () => {
        const q = drive();
        // A gesture holds his pose, so the tone waits behind the nod and the developer types meanwhile.
        q.ask("nod", 0);
        q.step(answer("frown"), 1000);
        q.step({ type: "key" }, 5000);
        expect(q.wakeAt).toBe(5000 + KeyQuietMs);
        q.wake();
        expect(q.played).toEqual([
            { expression: "nod", at: 0 },
            { expression: "frown", at: 5000 + KeyQuietMs },
        ]);
    });

    it("may smile again within the minute: it follows what he says", () => {
        const q = drive();
        q.step(answer("smile"), 0);
        q.step(answer("smile"), BurstMs + MinGapMs);
        expect(q.names()).toEqual(["smile", "smile"]);
        const plain = drive();
        plain.ask("smile", 0);
        plain.ask("smile", BurstMs + MinGapMs);
        expect(plain.names()).toEqual(["smile"]);
    });

    it("is still one expression at a time: it waits for the gap after another gesture", () => {
        const q = drive();
        q.ask("nod", 0);
        expect(q.step(answer("frown"), 2000).play).toBeNull();
        expect(q.wakeAt).toBe(MinGapMs);
        q.wake();
        expect(q.names()).toEqual(["nod", "frown"]);
    });
});

describe("the face of a visit (FR-BOSS-009, AC5)", () => {
    const table: [Severity, BrokkExpression][] = [
        ["grave", "frown"],
        ["important", "doubtful"],
        ["neutre", "call"],
        ["bonne", "smile"],
    ];

    it.each(table)("a %s visit wears %s", (severity, expression) => {
        expect(SeverityExpression[severity]).toBe(expression);
    });

    it("uses only expressions his portrait has", () => {
        for (const expression of Object.values(SeverityExpression)) {
            expect(Object.keys(ExpressionRank)).toContain(expression);
        }
    });

    it("ranks the gravest first, a call above good news", () => {
        expect(SeverityRank.grave).toBeGreaterThan(SeverityRank.important);
        expect(SeverityRank.important).toBeGreaterThan(SeverityRank.neutre);
        expect(SeverityRank.neutre).toBeGreaterThan(SeverityRank.bonne);
    });

    it("picks the gravest of several, and nothing from none", () => {
        expect(severest(["bonne", "neutre", "important", "neutre"])).toBe("important");
        expect(severest(["bonne", "neutre"])).toBe("neutre");
        expect(severest(["bonne"])).toBe("bonne");
        expect(severest(["bonne", "grave", "important"])).toBe("grave");
        expect(severest([])).toBeNull();
    });
});
