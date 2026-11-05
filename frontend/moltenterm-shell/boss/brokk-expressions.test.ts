// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
// The listening is tested with stand-in sources below: the real models pull the whole app in.
vi.mock("../agent-state-store", () => ({ AgentStates: { getInstance: () => ({}) } }));
vi.mock("../reviews/reviews-store", () => ({ ReviewsModel: { getInstance: () => ({}) } }));
vi.mock("./boss-store", () => ({ BossBubbleModel: { getInstance: () => ({}) } }));

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { LongWaitMs } from "./brokk-expression-model";
import { BrokkExpressionsModel, ExpressionSources, watchExpressions } from "./brokk-expressions";
import type { BrokkExpression } from "./brokk-state-model";

type Timer = { run: () => void; at: number };

// A clock and timers the test moves by hand: nothing waits for real time.
function makeWorld() {
    const store = createStore();
    const world = {
        store,
        time: 1_000_000,
        timers: [] as Timer[],
        agentsAtom: atom({ states: {}, versions: {} } as AgentStatesData) as PrimitiveAtom<AgentStatesData>,
        loadedAtom: atom(true) as PrimitiveAtom<boolean>,
        mergedAtom: atom({}) as PrimitiveAtom<Record<string, { merged?: number[] }>>,
        cueAtom: atom(0) as PrimitiveAtom<number>,
        asked: [] as BrokkExpression[],
        setAgents(...infos: Partial<AgentStateInfo>[]) {
            const states: Record<string, AgentStateInfo> = {};
            for (const info of infos) {
                states[info.blockid] = { version: 1, ...info } as AgentStateInfo;
            }
            store.set(world.agentsAtom, { states, versions: {} });
        },
        advance(ms: number) {
            world.time += ms;
            const due = world.timers.filter((timer) => timer.at <= world.time);
            world.timers = world.timers.filter((timer) => timer.at > world.time);
            due.forEach((timer) => timer.run());
        },
    };
    return world;
}

function listen(world: ReturnType<typeof makeWorld>) {
    const sources: ExpressionSources = {
        store: world.store,
        agentsAtom: world.agentsAtom,
        agentsLoadedAtom: world.loadedAtom,
        mergedAtom: world.mergedAtom,
        cueAtom: world.cueAtom,
        now: () => world.time,
        setTimer: (run, ms) => {
            const timer = { run, at: world.time + ms };
            world.timers.push(timer);
            return timer;
        },
        clearTimer: (timer) => {
            world.timers = world.timers.filter((other) => other !== timer);
        },
    };
    return watchExpressions(sources, (expression) => world.asked.push(expression));
}

describe("what the app asks of Brokk (FR-BOSS-007, AC3)", () => {
    it("makes the call gesture when the count of the badge rises, and for no rise at the start", () => {
        const world = makeWorld();
        world.store.set(world.cueAtom, 4);
        listen(world);
        expect(world.asked).toEqual([]);
        world.store.set(world.cueAtom, 5);
        expect(world.asked).toEqual(["call"]);
        world.store.set(world.cueAtom, 6);
        expect(world.asked).toEqual(["call", "call"]);
    });

    it("frowns when an agent fails, not for one that failed before the window opened", () => {
        const world = makeWorld();
        world.setAgents({ blockid: "old", state: "error", since: 5 });
        listen(world);
        expect(world.asked).toEqual([]);
        world.setAgents({ blockid: "old", state: "error", since: 5 }, { blockid: "new", state: "error", since: 9 });
        expect(world.asked).toEqual(["frown"]);
        world.setAgents({ blockid: "old", state: "error", since: 5 }, { blockid: "new", state: "working", since: 12 });
        expect(world.asked).toEqual(["frown"]);
    });

    it("waits for the first reading of the agents before it judges anything", () => {
        const world = makeWorld();
        world.store.set(world.loadedAtom, false);
        world.setAgents({ blockid: "a", state: "error", since: 5 });
        listen(world);
        world.store.set(world.loadedAtom, true);
        expect(world.asked).toEqual([]);
        world.setAgents({ blockid: "a", state: "error", since: 5 }, { blockid: "b", state: "error", since: 8 });
        expect(world.asked).toEqual(["frown"]);
    });

    it("looks doubtful once an agent has waited too long, when the limit comes and not before", () => {
        const world = makeWorld();
        listen(world);
        world.setAgents({ blockid: "a", state: "waiting", since: world.time });
        expect(world.asked).toEqual([]);
        expect(world.timers).toHaveLength(1);
        world.advance(LongWaitMs - 1000);
        expect(world.asked).toEqual([]);
        world.advance(2000);
        expect(world.asked).toEqual(["doubtful"]);
        world.advance(LongWaitMs * 3);
        expect(world.asked).toEqual(["doubtful"]);
        expect(world.timers).toHaveLength(0);
    });

    it("looks doubtful again for a block that waits again, and for none that answered meanwhile", () => {
        const world = makeWorld();
        listen(world);
        world.setAgents({ blockid: "a", state: "waiting", since: world.time });
        world.setAgents({ blockid: "a", state: "working", since: world.time });
        expect(world.timers).toHaveLength(0);
        world.advance(LongWaitMs * 2);
        expect(world.asked).toEqual([]);
        world.setAgents({ blockid: "a", state: "waiting", since: world.time });
        world.advance(LongWaitMs + 10);
        expect(world.asked).toEqual(["doubtful"]);
    });

    it("smiles when a pull request merges, not for the ones merged before the window opened", () => {
        const world = makeWorld();
        world.store.set(world.mergedAtom, { "/p": { merged: [1] } });
        listen(world);
        expect(world.asked).toEqual([]);
        world.store.set(world.mergedAtom, { "/p": { merged: [1, 2] } });
        expect(world.asked).toEqual(["smile"]);
        world.store.set(world.mergedAtom, {});
        expect(world.asked).toEqual(["smile"]);
    });

    it("stops listening, and drops the timer it had armed, when the bubble goes", () => {
        const world = makeWorld();
        const stop = listen(world);
        world.setAgents({ blockid: "a", state: "waiting", since: world.time });
        expect(world.timers).toHaveLength(1);
        stop();
        expect(world.timers).toHaveLength(0);
        world.store.set(world.cueAtom, 9);
        world.store.set(world.mergedAtom, { "/p": { merged: [1] } });
        expect(world.asked).toEqual([]);
    });
});

describe("the gesture asked", () => {
    beforeEach(() => {
        BrokkExpressionsModel.resetInstance();
        globalStore.set(BrokkExpressionsModel.getInstance().askedAtom, null);
    });

    it("is none until one is asked, and each asking has a cue of its own, the same gesture twice included", () => {
        const model = BrokkExpressionsModel.getInstance();
        expect(globalStore.get(model.askedAtom)).toBeNull();
        model.ask("smile");
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 1 });
        model.ask("smile");
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 2 });
        model.ask("nod");
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "nod", cue: 3 });
    });
});
