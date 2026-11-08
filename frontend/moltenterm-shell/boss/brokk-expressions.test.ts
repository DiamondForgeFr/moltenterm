// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

// The model listens to the bubble's atoms and to the agents: stand-ins of this file's own.
const Sources = vi.hoisted(() => ({
    cue: null as any,
    cardOpen: null as any,
    toHandle: null as any,
    agents: null as any,
}));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    Sources.cue = atom(0);
    Sources.cardOpen = atom(false);
    Sources.toHandle = atom({ items: [], info: [], parked: 0 });
    return {
        BossBubbleModel: {
            getInstance: () => ({
                cueAtom: Sources.cue,
                cardOpenAtom: Sources.cardOpen,
                toHandleAtom: Sources.toHandle,
            }),
        },
    };
});
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    Sources.agents = atom({ states: {}, versions: {} });
    return {
        AgentStates: { getInstance: () => ({ dataAtom: Sources.agents, loadedAtom: atom(true) }) },
    };
});
vi.mock("./developer-away", () => ({ InputEvents: ["pointermove", "keydown"] }));

import { globalStore } from "@/app/store/jotaiStore";
import type { ToHandleItem } from "./boss-to-handle-model";
import type { BrokkExpression } from "./brokk-ask-model";
import { BrokkExpressionsModel, watchCalls } from "./brokk-expressions";
import { BackMs, GreetWithinMs, ReplayEveryMs, ReturnAfterMs } from "./brokk-mood";
import { KeyQuietMs, MinGapMs, RepeatMs, ReplySettleMs } from "./brokk-queue";

const Min = 60_000;
const Start = new Date(2026, 10, 6, 10, 0, 0);

function failing(): ToHandleItem {
    return {
        key: "ci:/p:12",
        tone: "error",
        notice: null,
        lineFromNotice: false,
        name: "#12",
        line: { text: "CI failing" },
        place: "",
        since: 1,
        rank: 0,
        seen: false,
        actions: [],
    };
}

function setItems(items: ToHandleItem[]) {
    globalStore.set(Sources.toHandle, { items, info: [], parked: 0 });
}

function model() {
    return BrokkExpressionsModel.getInstance();
}

const asked = () => globalStore.get(model().askedAtom);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Start);
    BrokkExpressionsModel.resetInstance();
    globalStore.set(model().askedAtom, null);
    globalStore.set(Sources.cue, 0);
    globalStore.set(Sources.cardOpen, false);
    setItems([]);
});

afterEach(() => {
    BrokkExpressionsModel.resetInstance();
    vi.useRealTimers();
});

describe("the call Brokk makes when the count of the badge rises (FR-BOSS-007, AC3)", () => {
    function listen(start: number) {
        const store = createStore();
        const cueAtom = atom(start) as PrimitiveAtom<number>;
        const calls: BrokkExpression[] = [];
        const stop = watchCalls(store, cueAtom, (expression) => calls.push(expression));
        return { store, cueAtom, calls, stop };
    }

    it("makes the call gesture when the count rises, and for no rise at the start", () => {
        const { store, cueAtom, calls } = listen(4);
        expect(calls).toEqual([]);
        store.set(cueAtom, 5);
        expect(calls).toEqual(["call"]);
        store.set(cueAtom, 6);
        expect(calls).toEqual(["call", "call"]);
    });

    it("stops listening when the bubble goes", () => {
        const { store, cueAtom, calls, stop } = listen(0);
        stop();
        store.set(cueAtom, 9);
        expect(calls).toEqual([]);
    });
});

describe("the gesture asked goes through the queue (FR-BOSS-007, AC13)", () => {
    it("is none until one is asked, and each start has a cue of its own, the same gesture twice included", () => {
        expect(asked()).toBeNull();
        model().ask("smile");
        expect(asked()).toMatchObject({ expression: "smile", cue: 1 });
        vi.advanceTimersByTime(RepeatMs + 1);
        model().ask("smile");
        expect(asked()).toMatchObject({ expression: "smile", cue: 2 });
    });

    it("holds the next one back for the gap and starts it by itself when the gap is over", () => {
        model().ask("smile");
        model().ask("doubtful");
        expect(asked()).toMatchObject({ expression: "smile", cue: 1 });
        vi.advanceTimersByTime(MinGapMs - 1);
        expect(asked()).toMatchObject({ expression: "smile" });
        vi.advanceTimersByTime(1);
        expect(asked()).toMatchObject({ expression: "doubtful", cue: 2 });
    });

    it("keeps the gesture that tells why when the call is asked in the same moment", () => {
        model().ask("frown");
        const frown = asked();
        model().ask("call");
        expect(asked()).toBe(frown);
    });

    it("starts nothing within four seconds of a keystroke, and starts it at the pause", () => {
        model().noteKey();
        expect(globalStore.get(model().lastKeyAtAtom)).toBe(Start.getTime());
        model().ask("frown");
        vi.advanceTimersByTime(KeyQuietMs - 1);
        expect(asked()).toBeNull();
        vi.advanceTimersByTime(1);
        expect(asked()).toMatchObject({ expression: "frown" });
    });

    it("answers the developer with a nod after a beat, and with a smile when that answer cleared the list", () => {
        model().noteHandled("answer");
        expect(globalStore.get(model().moodAtom).handled).toMatchObject({ kind: "answer" });
        expect(asked()).toBeNull();
        vi.advanceTimersByTime(ReplySettleMs);
        expect(asked()).toMatchObject({ expression: "nod" });

        BrokkExpressionsModel.resetInstance();
        globalStore.set(model().askedAtom, null);
        model().noteHandled("handoff");
        model().ask("smile");
        vi.advanceTimersByTime(ReplySettleMs * 2);
        expect(asked()).toMatchObject({ expression: "smile", cue: 1 });
    });

    it("tells a merged pull request: a smile, the news and the good mood", () => {
        model().noteMerged(1955);
        expect(asked()).toMatchObject({ expression: "smile" });
        const memory = globalStore.get(model().moodAtom);
        expect(memory.news).toMatchObject({ kind: "merged", number: 1955 });
        expect(memory.satisfiedAt).toBe(Start.getTime());
    });
});

describe("what his mood plays when the screen or the card opens (FR-BOSS-007, AC12)", () => {
    it("frowns once for a failure that is still there, then not again before five minutes", () => {
        setItems([failing()]);
        model().noteOpen();
        expect(asked()).toMatchObject({ expression: "frown", cue: 1 });
        expect(globalStore.get(model().moodAtom).replayedAt).toBe(Start.getTime());
        vi.advanceTimersByTime(RepeatMs + 1);
        model().noteOpen();
        expect(asked()).toMatchObject({ cue: 1 });
        vi.advanceTimersByTime(ReplayEveryMs);
        model().noteOpen();
        expect(asked()).toMatchObject({ expression: "frown", cue: 2 });
    });

    it("plays nothing, and uses no budget, when nothing in his mood calls for it", () => {
        model().noteOpen();
        expect(asked()).toBeNull();
        expect(globalStore.get(model().moodAtom).replayedAt).toBeNull();
    });

    it("does not use its budget on a replay the queue folded into a gesture that just played", () => {
        model().ask("frown");
        setItems([failing()]);
        model().noteOpen();
        expect(globalStore.get(model().moodAtom).replayedAt).toBeNull();
    });

    it("smiles at a good mood, in the first five minutes", () => {
        model().note({ type: "cleared" });
        vi.advanceTimersByTime(RepeatMs);
        model().noteOpen();
        expect(asked()).toMatchObject({ expression: "smile" });
    });
});

describe("his greeting when the developer is back (FR-BOSS-007, AC14)", () => {
    it("nods once, when the screen opens soon after a long absence", () => {
        model().note({ type: "returned", since: Start.getTime() - 40 * Min });
        model().noteOpen();
        expect(asked()).toMatchObject({ expression: "nod" });
        expect(globalStore.get(model().moodAtom).back.greeted).toBe(true);
        vi.advanceTimersByTime(RepeatMs + 1);
        model().noteOpen();
        expect(asked()).toMatchObject({ cue: 1 });
    });

    it("does not greet someone who opens it later than two minutes after coming back", () => {
        model().note({ type: "returned", since: Start.getTime() - 40 * Min });
        vi.advanceTimersByTime(GreetWithinMs + 1);
        model().noteOpen();
        expect(asked()).toBeNull();
        expect(BackMs).toBeLessThan(GreetWithinMs);
    });
});

describe("what a bubble on screen listens to (FR-BOSS-007, AC3 and AC14)", () => {
    function fakeTarget() {
        const listeners = new Map<string, Set<(e: any) => void>>();
        return {
            addEventListener: (type: string, fn: (e: any) => void) => {
                listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
            },
            removeEventListener: (type: string, fn: (e: any) => void) => listeners.get(type)?.delete(fn),
            dispatch: (type: string) => listeners.get(type)?.forEach((fn) => fn({})),
            count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
        };
    }

    it("calls when the badge rises, and tells it for the summary of a return", () => {
        const target = fakeTarget();
        const stop = model().watch(target);
        globalStore.set(Sources.cue, 1);
        expect(asked()).toMatchObject({ expression: "call" });
        expect(globalStore.get(model().moodAtom).log).toHaveLength(1);
        stop();
    });

    it("does not call while the card is open: the developer is there", () => {
        const stop = model().watch(fakeTarget());
        globalStore.set(Sources.cardOpen, true);
        globalStore.set(Sources.cue, 1);
        expect(asked()).toBeNull();
        stop();
    });

    it("reads a keystroke as the quiet that holds the next gesture back", () => {
        const target = fakeTarget();
        const stop = model().watch(target);
        target.dispatch("keydown");
        globalStore.set(Sources.cue, 1);
        expect(asked()).toBeNull();
        vi.advanceTimersByTime(KeyQuietMs);
        expect(asked()).toMatchObject({ expression: "call" });
        stop();
    });

    it("sees the developer back after thirty minutes without an input, and not before", () => {
        const target = fakeTarget();
        const stop = model().watch(target);
        vi.advanceTimersByTime(ReturnAfterMs - 1);
        target.dispatch("pointermove");
        expect(globalStore.get(model().moodAtom).back).toBeNull();
        vi.advanceTimersByTime(ReturnAfterMs);
        target.dispatch("pointermove");
        expect(globalStore.get(model().moodAtom).back).toMatchObject({ greeted: false });
        stop();
    });

    it("frowns at a failure that appears, and stops listening when the bubble goes", () => {
        const target = fakeTarget();
        const stop = model().watch(target);
        setItems([failing()]);
        expect(asked()).toMatchObject({ expression: "frown" });
        stop();
        expect(target.count()).toBe(0);
        vi.advanceTimersByTime(Min);
        globalStore.set(Sources.cue, 5);
        expect(asked()).toMatchObject({ expression: "frown", cue: 1 });
    });
});
