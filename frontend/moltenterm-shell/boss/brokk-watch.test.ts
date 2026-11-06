// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import type { BrokkExpression } from "./brokk-ask-model";
import { EmptyMood, moodAfter, MoodEvent, MoodMemory, ReturnAfterMs } from "./brokk-mood";
import {
    ArrivalInput,
    ArrivalMemory,
    arrivalsAfter,
    EmptyArrivals,
    finishedNames,
    moodFactsOf,
    presenceAfter,
    watchBrokk,
    WatchSources,
} from "./brokk-watch";

const Min = 60_000;

function item(key: string, tone: ToHandleItem["tone"] = "waiting", extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone,
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: key },
        place: "",
        since: 0,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    };
}

function listOf(items: ToHandleItem[], extra: Partial<ToHandleList> = {}): ToHandleList {
    return { items, info: [], parked: 0, parkedKeys: [], ...extra };
}

function agent(blockid: string, state: AgentStateInfo["state"], extra: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return { blockid, agent: "claude", firstname: blockid, state, version: 1, since: 1, ...extra };
}

function data(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((info) => [info.blockid, info])), versions: {} };
}

describe("what arrives (FR-BOSS-007, AC3, #1959)", () => {
    function read(memory: ArrivalMemory, input: Partial<ArrivalInput> = {}) {
        const keys = input.keys ?? [];
        return arrivalsAfter(memory, {
            ready: true,
            keys,
            unseenKeys: keys,
            reviewDirs: [],
            ...input,
        });
    }

    it("tells nothing of the first reading, which is a window starting, nor before every source is in", () => {
        const notReady = read(EmptyArrivals, { keys: ["agent:a"], ready: false });
        expect(notReady.arrived).toEqual([]);
        expect(notReady.memory.known).toBeNull();
        const first = read(notReady.memory, { keys: ["agent:a"] });
        expect(first.arrived).toEqual([]);
        expect(first.memory.known).toEqual(new Set(["agent:a"]));
    });

    it("tells a row that was not there, whatever it is: an agent, a CI, a question, a hand-off request", () => {
        let memory = read(EmptyArrivals, { keys: [] }).memory;
        for (const key of ["agent:a", "ci:/p:12", "notif:n1", "handoff:r1", "ready:/p:13"]) {
            const step = read(memory, { keys: [...memory.known, key], reviewDirs: ["/p"] });
            expect(step.arrived, key).toEqual([key]);
            memory = step.memory;
        }
    });

    it("tells nothing for a row that stays, falls or comes back from Later", () => {
        const base = read(EmptyArrivals, { keys: ["agent:a", "agent:b"] }).memory;
        expect(read(base, { keys: ["agent:a", "agent:b"] }).arrived).toEqual([]);
        const fewer = read(base, { keys: ["agent:a"] });
        expect(fewer.arrived).toEqual([]);
        // Set aside, the row is in the keys of the rows (parked ones included) but not in those of the badge.
        const parked = read(base, { keys: ["agent:a", "agent:b"], unseenKeys: ["agent:a"] });
        expect(parked.arrived).toEqual([]);
        const back = read(parked.memory, { keys: ["agent:a", "agent:b"], unseenKeys: ["agent:a", "agent:b"] });
        expect(back.arrived).toEqual([]);
    });

    it("tells a row that is set aside and not counted by the badge only when the badge counts it", () => {
        const base = read(EmptyArrivals, { keys: ["agent:a"] }).memory;
        const seen = read(base, { keys: ["agent:a", "notif:n"], unseenKeys: ["agent:a"] });
        expect(seen.arrived).toEqual([]);
    });

    it("tells a row that leaves and arrives again", () => {
        let memory = read(EmptyArrivals, { keys: ["ci:/p:1"], reviewDirs: ["/p"] }).memory;
        memory = read(memory, { keys: [], reviewDirs: ["/p"] }).memory;
        expect(read(memory, { keys: ["ci:/p:1"], reviewDirs: ["/p"] }).arrived).toEqual(["ci:/p:1"]);
    });

    it("tells nothing of the pull requests of a project read for the first time", () => {
        const base = read(EmptyArrivals, { keys: ["agent:a"], reviewDirs: [] }).memory;
        const firstRead = read(base, { keys: ["agent:a", "ci:/p:1", "ready:/p:2"], reviewDirs: ["/p"] });
        expect(firstRead.arrived).toEqual([]);
        const later = read(firstRead.memory, {
            keys: ["agent:a", "ci:/p:1", "ready:/p:2", "ci:/p:3"],
            reviewDirs: ["/p"],
        });
        expect(later.arrived).toEqual(["ci:/p:3"]);
        // The agent that arrives with the first reading of a project is still an arrival.
        const mixed = read(firstRead.memory, {
            keys: ["agent:a", "ci:/p:1", "ready:/p:2", "agent:z", "ci:/q:9"],
            reviewDirs: ["/p", "/q"],
        });
        expect(mixed.arrived).toEqual(["agent:z"]);
    });

    it("starts over when a source goes back to not being read", () => {
        const base = read(EmptyArrivals, { keys: ["agent:a"] }).memory;
        const lost = read(base, { keys: ["agent:a"], ready: false });
        expect(lost.memory.known).toBeNull();
        expect(read(lost.memory, { keys: ["agent:a", "agent:b"] }).arrived).toEqual([]);
    });
});

describe("what the mood reads from the rows", () => {
    it("fails when a row in error is there, counts the rows, and picks the longest wait among those that wait", () => {
        const items = [
            item("agent:a", "waiting", { since: 500, name: "Olivia" }),
            item("agent:b", "waiting", { since: 100, name: "Arthur" }),
            item("ready:/p:1", "success", { since: 50 }),
            item("notif:n", "waiting", { since: 0 }),
        ];
        const facts = moodFactsOf(items);
        expect(facts).toEqual({
            failing: false,
            waiting: 4,
            oldest: { key: "agent:b", name: "Arthur", since: 100, agent: true },
        });
        expect(moodFactsOf([...items, item("ci:/p:2", "error")]).failing).toBe(true);
        expect(moodFactsOf([])).toEqual({ failing: false, waiting: 0, oldest: null });
    });

    it("names a row that is not an agent with the sentence it is given, and an agent's question by its sentence too", () => {
        const facts = moodFactsOf(
            [item("handoff:r1", "waiting", { since: 10, name: "Chloé" })],
            (row) => `${row.name}: Fix the login`
        );
        expect(facts.oldest).toEqual({ key: "handoff:r1", name: "Chloé: Fix the login", since: 10, agent: false });
        const question = moodFactsOf(
            [item("agent:q", "waiting", { since: 10, name: "Max", lineFromNotice: true })],
            () => "Max: Allow it?"
        );
        expect(question.oldest).toMatchObject({ name: "Max: Allow it?", agent: false });
    });
});

describe("who finished", () => {
    it("names the agents that were at work and are done now, and no other", () => {
        const before = data(agent("a", "working"), agent("b", "working"), agent("c", "waiting"), agent("d", "done"));
        const now = data(agent("a", "done"), agent("b", "error"), agent("c", "done"), agent("d", "done"));
        expect(finishedNames(before, now)).toEqual(["a"]);
        expect(finishedNames(null, now)).toEqual([]);
    });
});

describe("the developer's return", () => {
    it("is an input after thirty minutes without one, and tells since when", () => {
        expect(presenceAfter(1000, 1000 + ReturnAfterMs - 1)).toEqual({
            last: 1000 + ReturnAfterMs - 1,
            returnedSince: null,
        });
        expect(presenceAfter(1000, 1000 + ReturnAfterMs)).toEqual({ last: 1000 + ReturnAfterMs, returnedSince: 1000 });
        expect(presenceAfter(null, 5000)).toEqual({ last: 5000, returnedSince: null });
    });
});

type Timer = { run: () => void; at: number };

// A clock and timers the test moves by hand: nothing waits for real time.
function makeWorld() {
    const store = createStore();
    const world = {
        store,
        time: Date.UTC(2026, 10, 6, 10, 0, 0),
        timers: [] as Timer[],
        agentsAtom: atom(data()) as PrimitiveAtom<AgentStatesData>,
        loadedAtom: atom(true) as PrimitiveAtom<boolean>,
        toHandleAtom: atom(listOf([])) as PrimitiveAtom<ToHandleList>,
        asked: [] as { expression: BrokkExpression; reply?: boolean }[],
        memory: EmptyMood as MoodMemory,
        events: [] as MoodEvent[],
        setAgents(...infos: AgentStateInfo[]) {
            store.set(world.agentsAtom, data(...infos));
        },
        setItems(items: ToHandleItem[], extra: Partial<ToHandleList> = {}) {
            store.set(world.toHandleAtom, listOf(items, extra));
        },
        advance(ms: number) {
            world.time += ms;
            const due = world.timers.filter((timer) => timer.at <= world.time);
            world.timers = world.timers.filter((timer) => timer.at > world.time);
            due.forEach((timer) => timer.run());
        },
        names: () => world.asked.map((a) => a.expression),
    };
    return world;
}

function listen(world: ReturnType<typeof makeWorld>) {
    const sources: WatchSources = {
        store: world.store,
        agentsAtom: world.agentsAtom,
        agentsLoadedAtom: world.loadedAtom,
        toHandleAtom: world.toHandleAtom,
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
    return watchBrokk(sources, {
        ask: (expression, options) => world.asked.push({ expression, reply: options?.reply }),
        note: (event) => {
            world.events.push(event);
            world.memory = moodAfter(world.memory, event, world.time);
        },
        memory: () => world.memory,
    });
}

describe("what makes him react (FR-BOSS-007, AC12 to AC14)", () => {
    it("reacts to nothing that was there when the window started", () => {
        const world = makeWorld();
        world.setAgents(agent("a", "error"));
        world.setItems([
            item("agent:a", "error", { since: 1 }),
            item("agent:w", "waiting", { since: world.time - 40 * Min }),
        ]);
        const stop = listen(world);
        expect(world.asked).toEqual([]);
        expect(world.events.filter((event) => event.type !== "still" && event.type !== "told")).toEqual([]);
        stop();
    });

    it("reacts to nothing before the agents have been read", () => {
        const world = makeWorld();
        world.store.set(world.loadedAtom, false);
        const stop = listen(world);
        world.setItems([item("agent:a", "error", { since: 1 })]);
        expect(world.asked).toEqual([]);
        world.store.set(world.loadedAtom, true);
        expect(world.asked).toEqual([]);
        stop();
    });

    describe("a failure", () => {
        it("frowns once for a new failure, is concerned, and does not frown again for the same one", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("ci:/p:12", "error", { since: 5 })]);
            expect(world.names()).toEqual(["frown"]);
            expect(world.events).toContainEqual({ type: "failed" });
            world.setItems([item("ci:/p:12", "error", { since: 5 }), item("agent:z", "waiting")]);
            expect(world.names()).toEqual(["frown"]);
            world.setItems([
                item("ci:/p:12", "error", { since: 5 }),
                item("agent:z", "waiting"),
                item("agent:e", "error", { since: 9 }),
            ]);
            expect(world.names()).toEqual(["frown", "frown"]);
            stop();
        });

        it("nods with relief when the last failure is settled, and for no failure that is still there", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("ci:/p:1", "error", { since: 5 }), item("agent:e", "error", { since: 6 })]);
            world.asked.length = 0;
            world.setItems([item("agent:e", "error", { since: 6 })]);
            expect(world.asked).toEqual([]);
            world.setItems([]);
            expect(world.names()).toEqual(expect.arrayContaining(["nod"]));
            expect(world.events).toContainEqual({ type: "settled" });
            stop();
        });

        it("does not call a failure set aside with Later settled", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("agent:e", "error", { since: 6 })]);
            world.asked.length = 0;
            world.setItems([], { parked: 1, parkedKeys: ["agent:e"] });
            expect(world.events).not.toContainEqual({ type: "settled" });
            expect(world.asked).toEqual([]);
            stop();
        });
    });

    describe("a wave of work", () => {
        it("nods when the last agent at work finishes, and says it was everyone", () => {
            const world = makeWorld();
            world.setAgents(agent("a", "working"), agent("b", "working"));
            const stop = listen(world);
            world.setAgents(agent("a", "done"), agent("b", "working"));
            expect(world.asked).toEqual([]);
            expect(world.events).toContainEqual({ type: "finished", name: "a", all: false });
            world.setAgents(agent("a", "done"), agent("b", "done"));
            expect(world.names()).toEqual(["nod"]);
            expect(world.events).toContainEqual({ type: "finished", name: "b", all: true });
            stop();
        });

        it("does not nod for an agent that finishes while others work, nor for the one that stops on an error", () => {
            const world = makeWorld();
            world.setAgents(agent("a", "working"), agent("b", "working"), agent("c", "working"));
            const stop = listen(world);
            world.setAgents(agent("a", "done"), agent("b", "working"), agent("c", "working"));
            world.setAgents(agent("a", "done"), agent("b", "error"), agent("c", "working"));
            world.setItems([item("agent:b", "error", { since: 9 })]);
            world.asked.length = 0;
            world.setAgents(agent("a", "done"), agent("b", "error"), agent("c", "done"));
            expect(world.asked).toEqual([]);
            const last = world.events.filter((event) => event.type === "finished").pop();
            expect(last).toMatchObject({ name: "c", all: false });
            stop();
        });

        it("does not nod when the last agent at work starts waiting for you instead of finishing", () => {
            const world = makeWorld();
            world.setAgents(agent("a", "working"));
            const stop = listen(world);
            world.setAgents(agent("a", "waiting"));
            expect(world.names()).not.toContain("nod");
            stop();
        });
    });

    describe("the list is cleared", () => {
        it("smiles when the last row leaves, and says it was cleared", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("agent:a"), item("agent:b")]);
            world.asked.length = 0;
            world.setItems([item("agent:b")]);
            expect(world.asked).toEqual([]);
            world.setItems([]);
            expect(world.names()).toEqual(["smile"]);
            expect(world.events).toContainEqual({ type: "cleared" });
            stop();
        });

        it("does not smile when the rows are set aside with Later, or when nothing was there", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("agent:a")]);
            world.setItems([], { parked: 1, parkedKeys: ["agent:a"] });
            expect(world.names()).toEqual([]);
            world.setItems([]);
            expect(world.names()).toEqual([]);
            stop();
        });

        it("does not count a row the developer has already acted on", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("notif:n", "waiting")]);
            world.setItems([item("notif:n", "waiting", { seen: true })]);
            expect(world.names()).toEqual(["smile"]);
            stop();
        });
    });

    describe("a long wait", () => {
        it("looks doubtful at ten minutes and again at thirty, with no timer ticking in between", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("agent:a", "waiting", { since: world.time - 4 * Min })]);
            expect(world.names()).toEqual([]);
            world.advance(5 * Min);
            expect(world.names()).toEqual([]);
            world.advance(Min + 1);
            expect(world.names()).toEqual(["doubtful"]);
            world.advance(15 * Min);
            expect(world.names()).toEqual(["doubtful"]);
            world.advance(10 * Min);
            expect(world.names()).toEqual(["doubtful", "doubtful"]);
            world.advance(600 * Min);
            expect(world.names()).toEqual(["doubtful", "doubtful"]);
            stop();
        });

        it("does not look doubtful again at every reading: the same wait is told once", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("agent:a", "waiting", { since: world.time - 11 * Min })]);
            expect(world.names()).toEqual(["doubtful"]);
            world.setItems([item("agent:a", "waiting", { since: world.time - 11 * Min }), item("agent:b", "waiting")]);
            world.setItems([item("agent:a", "waiting", { since: world.time - 11 * Min })]);
            expect(world.names()).toEqual(["doubtful"]);
            stop();
        });

        it("tells a row again that waits again, once it had left", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([item("agent:a", "waiting", { since: world.time - 11 * Min })]);
            world.setItems([]);
            world.setItems([item("agent:a", "waiting", { since: world.time - 11 * Min })]);
            expect(world.names().filter((name) => name === "doubtful")).toEqual(["doubtful", "doubtful"]);
            stop();
        });

        it("does not ask for a wait that was already long when the window started, but remembers it was told", () => {
            const world = makeWorld();
            world.setItems([item("agent:a", "waiting", { since: world.time - 35 * Min })]);
            const stop = listen(world);
            expect(world.asked).toEqual([]);
            expect(world.memory.told["agent:a"]).toBe(30 * Min);
            world.advance(600 * Min);
            expect(world.asked).toEqual([]);
            stop();
        });

        it("is only about the rows that wait for an answer", () => {
            const world = makeWorld();
            const stop = listen(world);
            world.setItems([
                item("ready:/p:1", "success", { since: world.time - 40 * Min }),
                item("ci:/p:2", "error", { since: world.time - 40 * Min }),
            ]);
            world.advance(60 * Min);
            expect(world.names()).not.toContain("doubtful");
            stop();
        });
    });

    it("stops listening and clears its timer", () => {
        const world = makeWorld();
        const stop = listen(world);
        world.setItems([item("agent:a", "waiting", { since: world.time })]);
        expect(world.timers).toHaveLength(1);
        stop();
        expect(world.timers).toHaveLength(0);
        world.setItems([item("agent:a", "error", { since: 1 })]);
        expect(world.asked).toEqual([]);
    });
});
