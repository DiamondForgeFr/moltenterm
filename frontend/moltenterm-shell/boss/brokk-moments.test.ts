// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

// The listening is tested with stand-in sources below: the real models pull the whole app in. The agent states and the
// merges the default sources read are atoms of this file's own.
const Sources = vi.hoisted(() => ({ agents: null as any, loaded: null as any, merged: null as any }));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    Sources.agents = atom({ states: {}, versions: {} });
    Sources.loaded = atom(true);
    return { AgentStates: { getInstance: () => ({ dataAtom: Sources.agents, loadedAtom: Sources.loaded }) } };
});
vi.mock("../reviews/reviews-store", async () => {
    const { atom } = await import("jotai");
    Sources.merged = atom({});
    return { ReviewsModel: { getInstance: () => ({ afterMergeAtom: Sources.merged }) } };
});
vi.mock("./boss-store", () => ({ BossBubbleModel: { getInstance: () => ({}) } }));

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { BrokkExpression } from "./brokk-ask-model";
import { LongWaitMs } from "./brokk-expression-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { MomentSources, startMoments, watchMoments } from "./brokk-moments";

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
    const sources: MomentSources = {
        store: world.store,
        agentsAtom: world.agentsAtom,
        agentsLoadedAtom: world.loadedAtom,
        mergedAtom: world.mergedAtom,
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
    return watchMoments(sources, (expression) => world.asked.push(expression));
}

describe("what makes Brokk's face react while it is on screen (FR-BOSS-007, AC3)", () => {
    it("frowns when an agent fails, not for one that failed before the portrait mounted", () => {
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

    it("smiles when a pull request merges, not for the ones merged before the portrait mounted", () => {
        const world = makeWorld();
        world.store.set(world.mergedAtom, { "/p": { merged: [1] } });
        listen(world);
        expect(world.asked).toEqual([]);
        world.store.set(world.mergedAtom, { "/p": { merged: [1, 2] } });
        expect(world.asked).toEqual(["smile"]);
        world.store.set(world.mergedAtom, {});
        expect(world.asked).toEqual(["smile"]);
    });

    it("stops listening, and drops the timer it had armed, when the portrait goes", () => {
        const world = makeWorld();
        const stop = listen(world);
        world.setAgents({ blockid: "a", state: "waiting", since: world.time });
        expect(world.timers).toHaveLength(1);
        stop();
        expect(world.timers).toHaveLength(0);
        world.store.set(world.mergedAtom, { "/p": { merged: [1] } });
        world.setAgents({ blockid: "b", state: "error", since: 7 });
        expect(world.asked).toEqual([]);
    });
});

describe("one listening for every portrait on screen", () => {
    beforeEach(() => {
        BrokkExpressionsModel.resetInstance();
        globalStore.set(BrokkExpressionsModel.getInstance().askedAtom, null);
        globalStore.set(Sources.agents, { states: {}, versions: {} });
        globalStore.set(Sources.merged, {});
    });

    it("asks each gesture once when the bubble's screen and the card's header both show him", () => {
        const model = BrokkExpressionsModel.getInstance();
        const first = startMoments();
        const second = startMoments();
        globalStore.set(Sources.merged, { "/p": { merged: [1] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 1 });
        first();
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 2 });
        second();
    });

    it("stops with the last portrait, and a stop told twice counts once", () => {
        const model = BrokkExpressionsModel.getInstance();
        const first = startMoments();
        const second = startMoments();
        first();
        first();
        globalStore.set(Sources.merged, { "/p": { merged: [1] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile", cue: 1 });
        second();
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ cue: 1 });
    });

    it("starts again for a portrait that mounts later, from the facts of that moment", () => {
        const model = BrokkExpressionsModel.getInstance();
        startMoments()();
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2, 3] } });
        const stop = startMoments();
        expect(globalStore.get(model.askedAtom)).toBeNull();
        globalStore.set(Sources.merged, { "/p": { merged: [1, 2, 3, 4] } });
        expect(globalStore.get(model.askedAtom)).toMatchObject({ expression: "smile" });
        stop();
    });
});
